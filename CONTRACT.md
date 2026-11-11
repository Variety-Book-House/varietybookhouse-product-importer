# Book Scan Importer — Internal Contract

Standalone Node.js ESM program. Lives OUTSIDE the main repo. No repo code is modified.

## Layout

```
book-scan-importer/
├─ package.json          # type: module; scripts: test (vitest run), start, web
├─ .env.example
├─ .gitignore            # node_modules, .env, job/
├─ CONTRACT.md           # this file
├─ requirements.txt      # python: zxing-cpp, easyocr (+ opencv, torch deps)
├─ read_barcodes.py      # batch barcode scan (zxing-cpp) — JSON file in/out
├─ ocr_batch.py          # batch EasyOCR (hi, en) — JSON file in/out
├─ crop_book.py          # rembg book segmentation → bounding-box crop (no rotation)
├─ src/
│  ├─ run.mjs            # CLI: node src/run.mjs <folder> [--dry-run] [--limit N] [--web]
│  ├─ web.mjs            # UI server: node src/web.mjs [--port 4173]
│  ├─ config.mjs         # env loading + validation
│  ├─ state.mjs          # job/state.json load/save
│  ├─ image.mjs          # sharp crop/trim/orient/variants
│  ├─ py.mjs             # spawn helper for the python scripts (JSON file protocol)
│  ├─ barcode.mjs        # readBarcodes(images) → Map<id, barcodes[]> via read_barcodes.py
│  ├─ ocr.mjs            # runOcr(images) → Map<id, lines[]> via ocr_batch.py
│  ├─ shopcodes.mjs      # data/products_6digit.csv lookup (6-digit shop codes)
│  ├─ match.mjs          # normalise/levenshtein/scoring/barcode classify/title index (pure)
│  ├─ db.mjs             # pg Pool, parameterised queries only
│  ├─ r2.mjs             # S3 client for R2
│  ├─ pipeline.mjs       # orchestration: discover→per-book stream (crop→barcode→ocr→match→enrich)
│  ├─ commit.mjs         # upload variants + write to products (used by web UI)
│  └─ webui.html         # single-page review UI (inline CSS/JS)
├─ data/
│  ├─ products.json      # committed catalogue snapshot (matching source of truth)
│  └─ products_6digit.csv # product_name,product_code (6-digit shop sticker codes)
├─ test/
│  └─ *.test.mjs         # vitest, no live DB/R2/python
└─ job/
   ├─ state.json
   ├─ crops/<sha>.jpg    # display crop (white-bg trim)
   └─ originals/<sha>.jpg # normalized original used for barcode + OCR
```

## Env vars (from `.env` at program root; `.env.example` documents all)

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | *(required for commit only)* | Neon Postgres, same as main repo. Matching reads `data/products.json`. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`products`), `R2_PUBLIC_URL` | *(required for commit)* | Cloudflare R2 |
| `WEB_PORT` | `4173` | UI port |
| `GOOGLE_BOOKS_API_KEY` | *(optional)* | Free Google Books key — avoids keyless rate limits during ISBN enrichment |
| `LLM_HOST` | `http://127.0.0.1:1234` | LM Studio OpenAI-compatible server (`/v1/chat/completions`) |
| `LLM_MODEL` | *(empty → auto)* | Model id; empty auto-picks LM Studio's loaded model |

OCR runs locally via `pip install -r requirements.txt` (zxing-cpp, EasyOCR, indic-transliteration); the web UI health check verifies the scripts and python imports. The LLM is local too (LM Studio) — no LLM keys needed.

Config validation: `loadConfig({ needDb, needR2 })` returns `{ ok, errors, config }` — never throws. `run.mjs` prints a friendly table of missing vars and exits 1.

## Enrichment (`enrich.mjs`) — ISBN metadata + local-LLM descriptions/genres

Runs for every book with a valid `isbn` at the end of the pipeline (`enrichBooks` phase), and on
demand via `POST /api/book/:key/enrich`. Never throws — always returns either an enrich object or a
`{ provider: null, error }` record that grounds the next retry. A missing/none description + no
genres + failed generation also returns `error` so the next run retries the LLM.

1. `fetchBookMeta(isbn, opts)`: **Google Books** `/books/v1/volumes?q=isbn:` (optional `key=`,
   `GOOGLE_BOOKS_API_KEY`) → if no record, **Open Library** `/api/books?bibkeys=ISBN:` — both free,
   both `timeout: 8s`, network/parse failures yield `null`. Per-provider host override via
   `googleHost` / `openLibraryHost` (tests inject stub servers).
2. `genres` = `cleanGenres(provider categories)` (trim, dedupe case-insensitive, max 4). If empty —
   or the provider ships no description — `generateContent()` posts a system+user chat to
   `{LLM_HOST}/v1/chat/completions` with `temperature: 0.35`, optional `response_format:
   json_object`, `timeout: 120s`, model `{LLM_MODEL}` (empty → auto-picked from `/v1/models`; on
   unknown-model 4xx it retries with the first installed model). Prompt supplies only real metadata
   + OCR blurb; the model must return `{"description": "…", "genres": ["A", "B"]}`. Non-JSON /
   unreachable → `null` → `descriptionSource: "none"` (+ `error` when neither description nor genres
   could be produced).
3. `llmStatus()` health probe (`GET /v1/models`, 4s timeout) → `{ ok, model, hasModel, installed }`;
   memoised in `web.mjs` for 15s.

## state.json (job/state.json) — single source of truth

```js
{
  folder: "/abs/path",          // the source folder this state belongs to
  dryRun: false,
  updatedAt: "ISO string",
  images: {
    [sha256Hex]: {
      sha, file, path,          // file = basename, path = absolute
      status: "pending" | "cropped" | "ocr_done" | "committed" | "failed",
      error: string | null,
      dims: { width, height },  // post-crop pixels
      barcode: null | { isbn, shopCode, raw: [{ format, text, valid }] },
      productId: string | null,   // resolved catalogue id (shopcode or title match)
      matchMethod: null | "shopcode" | "title",
      useOriginal: false,         // UI toggle: upload job/originals/ instead of crops
      manualCrop: null | { x0, y0, x1, y1 },  // UI "crop it myself": fractions (0..1) of the EXIF-normalized job/originals/ rect; crops/<sha>.jpg is a straight sharp extract of that box
      splitKey: null | string,  // UI "⤳ another book": pins this image to its own book group (`s:<sha12>`), overriding the productId/title grouping key; survives pipeline re-runs
      shopCodeUnresolved: false,  // 6-digit sticker decoded but absent from products_6digit.csv
      positionOverride: null | "front" | "back",  // UI front/back correction; null = use ocr.position
      ocr: null | {
        position: "front" | "back",   // back = barcode present, else front
        title, author, isbn,    // strings, "" if none
        priceText,              // exact printed price text, e.g. "₹499"
        price: number | null,   // parsed integer rupees
        blurb
      }
    }
  },
  books: {
    [key]: {                    // key = "p:<productId>" if resolved, else "t:<normalizedTitle|fileBase>"
      key, sortIndex,           // sortIndex = index of FRONT file in alphabetical folder order
      title, author, isbn, price: number | null, blurb,
      front: sha, back: sha | null,
      productId: string | null, shopCode: string,   // "" when no 6-digit sticker
      shopCodeUnresolved: boolean, // sticker decoded but missing from products_6digit.csv
      matchMethod: null | "shopcode" | "title",
      barcodePresent: boolean,  // any raw barcode on any image in the group
      status: "matched" | "needs_review" | "unmatched" | "committed" | "created",
      dismissed: false,
      score: 0,
      matchReason: string,
      candidates: [ { id, title, author, mrp, isbn, score, titleScore, mrpMatch, authorMatch } ],
      chosenProductId: string | null,   // set by UI confirm
      createdProductId: string | null,  // set by UI create-product
      commitError: string | null,
      urls: null | { frontDetail, frontCard, backDetail, backCard },
enrich: null | {
        provider: "google" | "openlibrary" | null,
        title: string, authors: string[], publisher: string, year: string, pageCount: number,
        categories: string[], coverThumb: string,
        genres: string[],                     // cleanGenres() result, max 4, deduped
        description: string,                  // provider description or LLM-generated ("" when none)
        descriptionSource: "provider" | "generated" | "none",
        descriptionModel: string | null,      // model used when generated
        generatedAt: "ISO string",
        error: string | null               // lookup/LLM failure → retried on next run
      }
    }
  }
}
```

State rules:
- `state.mjs` exports `JobState` class: `load()`, `save()` (atomic: write tmp + rename), `addImage`, `setBook`, `rebuildBooks(ocrBySha)` static helper is in pipeline instead.
- Folder guard: if a loaded state.json's `folder` differs from the CLI arg, error with exit (unless `--force` passed, which re-initialises).

## Image pipeline (`image.mjs`) — "orientation correct" requirement

Input: raw file buffer of a book scan on white paper.

1. `cropWhiteBg(buffer)` → `{ buffer (JPEG q90, no EXIF), width, height }`
   - Spawns `crop_book.py` (rembg `isnet-general-use` → largest external contour → convex-hull recovery → `boundingRect` crop) for book segmentation; on any failure falls back to `sharp .trim({ threshold: 150 })`. Set `BSI_SKIP_SAM=1` to skip the spawn entirely (tests do this — keeps vitest fast and low-memory). Override the model with `BSI_CROP_MODEL`.
   - **`crop_book.py` NEVER rotates or warps.** It used to deskew via `minAreaRect` + `getPerspectiveTransform`, but these are upright phone photos and the warp turned mask-noise "tilt" into a visibly ROTATED cover (back covers worst, since the sticker strip poisons the quad). The crop is always the axis-aligned bounding box of the (hull-recovered) contour; a genuinely tilted book just gets background in the corners.
   - One ordering rule in `crop_book.py` is load-bearing:
     - **Hull recovery runs before the size bail-out.** isnet returns the *salient artwork*, so on a plain cover the largest blob is ~1% of the frame while the convex hull of every blob spans the real book edges. The old code raised `Foreground too small` at 2% first, which made the hull branch unreachable and silently dropped such scans to `sharp.trim()`.
   - `sharp(buffer).rotate()` (apply EXIF orientation) in all paths
   - No auto-rotation: `cropWhiteBg` never calls `.rotate(90)`. A blind landscape→portrait flip turned already-correct crops (especially back covers) on their side. EXIF orientation is still normalized with `sharp(buffer).rotate()` in every path.
   - Output orientation matches the (EXIF-normalized) source; EXIF stripped.
2. `buildVariants(buffer)` → `{ card: Buffer, detail: Buffer }`
   - card: `.resize({ width: 400, withoutEnlargement: true }).webp({ quality: 78 })`
   - detail: `.resize({ width: 1000, withoutEnlargement: true }).webp({ quality: 80 })`
   - (same specs as the main repo's `lib/r2-compress.mjs`)

Two outputs written per image:
- `job/crops/<sha>.jpg` — white-bg trimmed display crop (UI thumbnails, upload default). May be REPLACED by a UI "crop it myself" rectangle (`POST /api/image/:sha/crop`, straight `sharp.extract` on the original — no deskew; these scans are upright). The pre-manual auto crop is backed up once to `job/crops/<sha>.auto.jpg` so `reset: true` can restore it. While `image.manualCrop` is set and the crop file exists, the pipeline's crop phase SKIPS auto-cropping (user data must survive re-runs).
- `job/originals/<sha>.jpg` — orientation-normalized original (`toOriginalJpeg`, max side 2048, q85) used for **barcode + OCR**; UI can toggle per image (`useOriginal`) so a bad crop doesn't lose data. Commit uploads pick original vs crop accordingly (`commit.sourceFile`).

## Barcode + OCR (local python, no LLM)

- `src/py.mjs` `pythonLaunch()`: returns `{ cmd, pre }` — `py -3` on Windows, `python3` elsewhere, overridable via `PYTHON_BIN`. `runPy(script, items, { timeout })`: writes `job/tmp/<name>-<rand>.json`, spawns `<pythonLaunch> <script> in out`, reads result, always unlinks temp files, captures stderr, throws with stderr snippet on failure or non-zero exit.
- `read_barcodes.py` — batch; per item tries original → 2× upscale → adaptive threshold, × 4 rotations via zxingcpp `read_barcodes`; stops at first hit; returns `[{ ok, barcodes: [{ format, text, valid }], error }]`.
- `ocr_batch.py` — batch; EasyOCR reader with `['hi','en']`, `gpu=False`, one Reader per run; lines sorted top→bottom: `[{ text, conf (0..100), box: [x, y, w, h], roman? }]`. `roman` is added when `text` is Devanagari: transliterated via `indic-transliteration` (IAST) then ASCII-folded and title-cased (`श्रीमद् भागवत पुराण` → `Srimad Bhagavata Purana`).
- `src/barcode.mjs` `readBarcodes(images)` → `Map<id, barcodes[]>`; `src/ocr.mjs` `runOcr(images)` → `Map<id, lines[]>`.
- Image flow in pipeline: crop + original written first (`status: 'cropped'`), then barcode, then OCR — all on the original path, **one image per spawn** (see Book-wise streaming below). A crop or scan failure marks that image `failed` and the run continues with the next image; it does not abort the job.

## Book-wise streaming (pipeline)

There are no phase-wide passes. `orchestrate` walks the work list in folder order and drives **one
image at a time through every phase**, then finalizes its book before touching the next image:

```
image 1 → crop → barcode → ocr → resolve productId → group → book complete? → match → enrich
image 2 → crop → barcode → ocr → …
```

- `rebuildBooks(state, files)` is the full rebuild (recomputes every group, prunes groups whose
  images are gone). `refreshBooks(state, files, keys)` is the streaming counterpart: it recomputes
  only the group an image just joined. `groupKeyFor(entry, file)` is the single definition of a
  group's key, shared by both.
- A book is **finalized** (matched, then enriched) as soon as it has both a front and a back.
  Books still missing a side at end of run are flushed by a final `rebuildBooks` + per-book finalize.
- `matchBooks` / `enrichBooks` take an optional `keys` array to operate on one book, and
  `matchBooks` takes `products` to reuse an already-loaded catalogue. Progress is driven by the
  caller in this path so the per-phase totals stay correct instead of being reset per book.
- Trade-off: python is spawned **per image** rather than per run, so EasyOCR reloads its weights
  for every scan. That is the cost of getting book *n* finished before book *n+1* starts.
- `--stop-at PHASE` is a gate inside the per-image loop, not a separate pass: it means "run every
  image up to this phase, then stop". `complete` (or no flag) runs everything. `run.mjs` forwards it.

## Matching (`match.mjs`, pure functions, unit-tested)

- `normalize(s)`: lowercase, strip non-`[a-z0-9 ]`, collapse spaces.
- `levenshtein(a, b)`: standard DP.
- `titleScore(a, b)`: `max(0, 100 - 100 * dist / max(lenA, lenB, 1))` on normalized strings.
- `parsePrice(text)`: matches `/₹\s*(\d[\d,]*)/`, `/Rs\.?\s*(\d[\d,]*)/`, `/(INR)\s*(\d+)/i`; strips commas → int or null.
- `scoreCandidate(product, book)` where book = `{ title, author, isbn, price }`:
  - `titleScore` = titleScore(product.title, book.title)
  - `mrpMatch` = book.price != null && product.mrp === book.price
  - mrp score = book.price == null ? 8 : (mrpMatch ? 40 : 0)
  - `authorMatch` = both present && (norm(product.author).includes(norm(book.author)) || reverse)
  - author score = authorMatch ? 15 : 0
  - isbn bonus = 25 when both present and digit-strings equal
  - `score` = sum
- `rankBooks(products, book)` → sorted top-5 candidate objects (contract shape above).
- `decide(candidates, book)`:
  - no candidates → `{ status: "unmatched", reason }`
  - best.score >= 135 && (best.score - second.score) >= 15 → `matched`
  - else if best.score >= 95 → `needs_review`
  - else → `unmatched`
  - If DB unavailable → all books `needs_review` with reason "database unavailable — match manually".
- `parsePrice(text)` / `matchPrice(text)` → `null` or `{ value, text }`; `priceFromLines(lines)` takes the first conf ≥ 40 line with a price in 10..99999 → `{ price, priceText }`.
- `blurbFromLines(lines, title?)` → longest conf ≥ 40 line ≥ 80 chars (excluding the title line), as-is.
- `classifyBarcodes(raw)` → `{ isbn, shopCode }`:
  - format `EAN_13`/`ISBN`, 13 digits, `isValidIsbn` → isbn (raw `valid` flag ignored, checksum rules win)
  - exactly 6 digits → shopCode (shop sticker)
  - everything else ignored
- `matchNorm(s)` = `normalize(s)` + spelling folds for matching only (`sh`→`s`, `w`→`v`) — used by `titleScore`, the title index and exact lookups; NOT by `normalize` itself (slugs/grouping keys stay untouched).
- `titleScore(a, b)` scores on `matchNorm` of both sides.
- `bestTitleMatch(line, products, minScore=95)` → `{ product, score, exact, line }` or null. Uses a memoised title index (`titleIndex(products)`, WeakMap) on `matchNorm`: exact lookup first, else inverted token index narrows candidates, then `titleScore` ≥ minScore. Tries a trailing-schwa variant of the candidate (`bhagavata purana` → `bhagavat puran`) so transliterated Hindi matches human-typed catalogue spellings.
- `bestTitleMatchLines(lines, products, minScore)` scores the joined title block (`pickTitleFromLines`) plus each conf ≥ 40 line (original and `roman`), returns the best hit with the matched `line`.
- `pickTitleFromLines(lines)` (in match.mjs): groups conf ≥ 50 lines into vertically-adjacent blocks, picks the block with the tallest lines, joins top-to-bottom preferring `roman` over `text` (raw display title fallback).

## Shop codes (`shopcodes.mjs`)

- `data/products_6digit.csv` — columns `product_name,product_code` (6-digit sticker code), 78k+ rows, UTF-8 BOM stripped.
- `fetchShopCodes()` → memoised `Map<code, name>`; `parseCsv` handles quotes/CRLF/blank lines.
- `resolveShopCode(code, products)` → `{ name, product, score, exact }` via `bestTitleMatch(name, products, 95)`; null when unknown code or no ≥95 title match.

## Pairing / books (pipeline)

- Per image: `position = barcode present ? "back" : "front"` (barcode ⇒ back cover; no barcode ⇒ assume front).
- Title resolution per image (in order): shop code → `products_6digit.csv` name → catalogue product (`matchMethod: 'shopcode'`); else best OCR line ≥ 95 (`matchMethod: 'title'`); else heuristic largest text block (vertically-merged conf ≥ 50 lines, joined top-to-bottom) as raw title.
- Group key = `p:<productId>` when resolved, else `t:<normalizedTitle|fileBase>` — strict product-id pairing only (no filename-order pairing). A UI-set `splitKey` (`s:<sha12>`) overrides the key entirely, splitting that image into its own book (`pipeline.splitImage` recomputes both the group it left and the one it joined, then `matchBooks` re-matches them; `merge` clears it). `groupKeyFor` honors `splitKey` on every rebuild, so a split survives pipeline re-runs.
- Barcode-authoritative alignment: the catalogue contains duplicate titles (same title, different ids/MRPs). When any image in the run resolves its product via shop code, that id is recorded as authoritative for its title; after OCR, any `matchMethod: 'title'` image whose (catalogue) title equals it is re-pointed to the barcode-resolved id — so front/back group onto the id the barcode proved correct.
- front/back pick within the group: effective position = `positionOverride ?? ocr.position`. Front = first (in list order) entry whose effective position is `front` among entries NOT explicitly overridden to `back` (else first); back = different entry with effective `back`, not overridden to `front`. Overrides are exclusive, so one UI click swaps the pair. Recompute happens server-side via `recomputeBookForImage(state, sha)` (pipeline.mjs) — refreshes only that image's group key.
- `sortIndex` = index of front file in the alphabetical listing of the folder. Books are always processed/committed in ascending `sortIndex` ("first in folder = first in SQL").
- Book's `title/author/isbn/price/blurb`: prefer front image OCR, fall back to back image.
- ISBN: barcode ISBN first, else valid ISBN found in OCR lines (`isValidIsbn` check digit; invalid discarded).
- `matchBooks`: `matchMethod: 'shopcode'` → status `matched` directly (score = candidate's), unless the scanned price differs from catalogue MRP → `needs_review` with the conflict reason. `'title'`/no method → `decide()` on ranked candidates. When a barcode was found but nothing matched confidently → forced `needs_review` ("barcode found but no confident catalogue match") instead of `unmatched`. Missing product id in the snapshot → `needs_review` ("resolved product id missing from catalogue snapshot"). `shopCodeUnresolved` (sticker decoded but not in `products_6digit.csv`) → a would-be `matched` is clamped to `needs_review` with reason "sticker code <n> not in products_6digit.csv — <original reason>"; the UI shows a `CODE <n> · not in csv` badge on the card.

## R2 (`r2.mjs`)

- `S3Client` (region `auto`, endpoint `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`) — same shape as repo `src/lib/r2.ts`.
- Keys (source folder sub-name sanitised, no dashes-underscores-only):
  - `optimized/card/<slug>/<safeFileName>.webp`
  - `optimized/detail/<slug>/<safeFileName>.webp`
  - slug = normalized title truncated to 60 chars (lowercase, spaces→`-`), else `book-<sha8>`
- `putIfMissing(key, body)` → HeadObject; on 404/NotFound Put with `ContentType: image/webp`, `CacheControl: public, max-age=31536000, immutable`.
- `publicUrl(key)` = `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`

## Catalogue snapshot — matching never queries the database

- `data/products.json` is the committed source of truth for matching:
  `{ fetchedAt, count, products: [{ id, title, author, mrp, isbn }] }`.
- Regenerate with `node scripts/snapshot-products.mjs` (the only code that reads the `products` table wholesale).
- `fetchProducts()` reads and memoises that file — no pool, no network. Missing/corrupt file throws and all books fall back to `needs_review`.
- `DATABASE_URL` is needed only at commit time, not to match.

## DB (`db.mjs`) — `pg` Pool, parameterised SQL only. Commit path only.

- `fetchProducts()` → reads `data/products.json` (see above). **No SQL.** Memoised by file mtime (one `statSync` per call): a regenerated/appended snapshot is picked up by a long-lived web server without a restart; if the file changes but becomes unreadable, the last-good rows are kept.
- `commitBook({ productId, newImages, newThumbnails, isbn, orientation: 'portrait', genre })`:
  - read current row (`SELECT ... FOR UPDATE`), merge pairs deduped on the detail URL (`mergePairs` in db.mjs): the thumbnail always travels with its own image (`null` when unknown), so `images.length === thumbnails.length` and both stay index-aligned forever. `commitBook` takes `placement: 'front' | 'back'` (from the leading cover's `positionOverride ?? ocr.position` in `commit.mjs`): `'front'` PREPENDS this book's pairs, `'back'` APPENDS them — so a back-only book committed after its front (front/back arrive in separate books when only one of them resolves the product id) can never hijack index 0.
  - `genre` (default `[]`) merged with the row's existing `genre` column via `mergeGenres` (dedupe case-insensitive, existing first).
  - `ensureGenres(client, genres)` in the same transaction: `INSERT INTO genres (genre) VALUES ($1) ON CONFLICT (genre) DO NOTHING` — never creates duplicates; callers must pass the same `client` as the update transaction.
  - `UPDATE products SET images = $1, thumbnails = $2, "ISBN" = COALESCE("ISBN", $3), genre = $4 WHERE id = $5` (genre `$4` = deduped merged list; kept only when the list is non-empty).
- `createProduct({ title, author, mrp, isbn, images, thumbnails, genres })` →
  `INSERT INTO products (title, author, mrp, "ISBN", images, thumbnails, stock, "is_active", genre) VALUES (...)` RETURNING id, in a transaction that runs `ensureGenres` first (genres default `[]`, deduped; stock 0, is_active true, `type` null)
- `appendCatalogue({ id, title, author, mrp, isbn })` — folds a just-created product into the catalogue WITHOUT reading the products table: pushes the row into the memoised in-memory list (so `/api/search` and later matching see it immediately) and rewrites `data/products.json` atomically (tmp+rename, refreshed `count`/`fetchedAt`). Deduped by id. If the snapshot file was missing/corrupt the memory still gains the row but the file is NOT rewritten — a partial file would mask the "snapshot missing → needs_review degradation" signal; regenerate via `scripts/snapshot-products.mjs` instead. Path overridable in tests via `BSI_CATALOGUE_PATH` (read at module load).
- Pool: `new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 30000 })`; opened lazily on the first write only; `close()` exported.

## Web UI (`web.mjs`, port WEB_PORT default 4173)

- `node:http` only, no framework. Serves `webui.html` at `/`.
- Routes:
  - `GET /` → html; `GET /health` → `{ ok: true }`
  - `GET /img/:sha?src=orig` → `job/crops/<sha>.jpg`, or `job/originals/<sha>.jpg` when `src=orig` (cross-fallback if missing)
  - `GET /api/state` → `{ folder, dryRun, ocr: { ok, error? }, db: { ok }, r2: { ok }, llm: { ok, model?, hasModel?, installed? }, enrichModel, counts: { matched, review, unmatched, failedImages, committed }, books: BookState[], images: ImageState[] }`
    - `ocr.ok` = python scripts present and `pythonLaunch() -c "import zxingcpp, cv2, easyocr, indic_transliteration"` succeeds (memoised per process)
    - `llm.ok` = `llmStatus()` (LM Studio `/v1/models`); memoised 15s to keep `/api/state` fast
  - `POST /api/image/:sha/source` body `{ source: "crop" | "original" }` → sets `useOriginal` on the image, saves; 404 for unknown sha
  - `POST /api/image/:sha/position` body `{ position: "front" | "back" | "auto" }` → sets/clears (`auto` → null) `positionOverride`, re-runs `recomputeBookForImage` so the book's front/back pick updates immediately; 400 for invalid position, 404 for unknown sha
  - `POST /api/image/:sha/split` body `{ action: "out" | "merge" }` → `out`: pins the image to its own book group `s:<sha12>` (`splitImage` recomputes the old and new groups, then `matchBooks` re-matches both keys); refuses with 409 if the image is already split or committed, 400 if it isn't groupable yet. `merge`: clears `splitKey`, recomputes both keys (the orphaned split book is deleted by `refreshBooks`), re-matches; 400 when nothing to merge. Response `{ ok, sha, action, keys }`
  - `POST /api/image/:sha/crop` body `{ x0, y0, x1, y1 }` (fractions 0..1 of the EXIF-normalized original; order-insensitive, clamped, min 16px output) → straight `sharp.extract` written to `job/crops/<sha>.jpg` (tmp+rename, q90); first crop backs up the auto crop to `crops/<sha>.auto.jpg`; sets `manualCrop` + new `dims`. Body `{ reset: true }` restores the backup and clears `manualCrop` (400 when none set). Response includes `v` (epoch ms) — the UI appends it to `/img/:sha` to bust the thumbnail cache. 404 when originals or the sha are missing; never touches barcode/OCR (they read `originals/`)
  - `POST /api/book/:key/confirm` body `{ productId }` → sets `chosenProductId`, status `matched`, saves
  - `POST /api/book/:key/dismiss` → `dismissed = true`
  - `POST /api/book/:key/create` body `{ title, author, mrp, isbn }` → `db.createProduct` (book's OCR values prefilled in UI; `book.enrich?.genres` passed as the initial product genres) → sets `createdProductId`, status `created`. The UI shows this as a "Create new product" `<details>` disclosure on every unresolved card (an option alongside candidates/search-picker, not a fallback only when nothing matched; it defaults to open when there are no candidates or status is `unmatched`, and the user's open/closed toggle is remembered per book key across re-renders). After a successful create the route calls `db.appendCatalogue` so the new product immediately joins the search/matching catalogue (in memory + `data/products.json`); an append failure never fails the request — the book state is saved and the response gains `catalogueError`, which the UI surfaces as a toast.
  - `POST /api/book/:key/enrich` → runs `enrichBook(book)` in process (network + LLM, can take ~90s), saves `book.enrich`, returns updated book; 400 when the book has no valid `isbn`
  - `POST /api/commit` → `commitConfirmed()` (commit.mjs): for each non-committed book with chosen or created product, in ascending sortIndex: upload variants → db.commitBook → status `committed`, store `urls`. Any error → book `commitError`, stays non-committed. Response: `{ results: [{ key, status, error }] }`
  - `POST /api/retry` → re-run crop+OCR for images with status `failed` (and any pending), then rebuild books + re-match, save. Response `{ retried, failed }`
- All state mutations go through `JobState.save()`.

## CLI (`run.mjs`)

```
node src/run.mjs <folder> [--dry-run] [--limit N] [--force] [--web]
```
- `--dry-run`: no R2 uploads, no DB writes (DB reads for matching allowed; if DB unreachable, books become `needs_review`).
- `--limit N`: process only first N unprocessed images.
- `--stop-at crop|ocr|match|enrich|complete`: run every image up to that phase, then stop.
- After pipeline: print table of books by status with top candidate, then hint `node src/web.mjs` to review. With `--web`, start the UI server inline.
- Never re-process `committed` or `ocr_done` images (idempotent); `failed` images only on explicit retry.

## Conventions

- ESM everywhere, Node >= 18, no TypeScript, no framework.
- No comments in code unless non-obvious WHY.
- No secrets in code: all from env (`.env` at program root, loaded via `dotenv/config` in config.mjs).
- Errors: log with `console.error`, mark state entry `failed`, never crash the whole batch.
