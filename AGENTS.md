# AGENTS.md

Standalone Node ESM tool that imports scanned book covers into the Variety Book House catalogue.
Lives **outside** the main repo — no repo code is modified. `CONTRACT.md` is the detailed spec
(state schema, match scoring, HTTP routes); read it before changing behaviour.

## Commands

```sh
npm test                                  # vitest run — the only gate (no lint/typecheck/format tooling exists)
npx vitest run test/match.test.mjs        # single file
BSI_SKIP_SAM=1 node src/run.mjs <folder> --dry-run --no-enrich   # pipeline, no DB/R2 writes
node src/web.mjs                          # review UI on WEB_PORT (default 4173)
node scripts/snapshot-products.mjs         # regenerate data/products.json (needs DATABASE_URL)
```

There is no eslint/prettier/tsconfig/husky — don't look for a `lint` step. `npm test` runs in <1s
with no network, DB, R2 or Python; keep it that way.

## Architecture facts that aren't obvious from filenames

- **The pipeline streams book-wise, one image at a time** — `crop → barcode → ocr → match → enrich`
  per image, then finalize its book (front+back seen) before starting the next. There are no
  phase-wide passes. `rebuildBooks` = full rebuild, `refreshBooks(state, files, keys)` = recompute
  only the group an image just joined; both share `groupKeyFor()`. `matchBooks`/`enrichBooks` take
  an optional `keys` array. Cost: python spawns per image, so EasyOCR reloads per scan.
- **Matching never touches Postgres.** `fetchProducts()` (`src/db.mjs:46`) reads and memoises the
  committed snapshot `data/products.json`. Regenerate via `scripts/snapshot-products.mjs` — the
  one place that reads the `products` table (`db.appendCatalogue` also writes the snapshot, but only
  appends the row it just created via `createProduct`, never reads the table). Missing/corrupt snapshot → every book degrades to
  `needs_review`, silently. The `pg` Pool is opened lazily and only by `commitBook`/`createProduct`.
  (`.env.example` still claims `DATABASE_URL` is needed for matching — it's stale.)
- **Two derived images per scan**, both keyed by the sha256 of the source bytes:
  `job/crops/<sha>.jpg` (bounding-box crop, never rotated — UI thumbnails + default upload) and
  `job/originals/<sha>.jpg` (EXIF-normalized — **barcode and OCR always run on the original, never
  the crop**). The per-image `useOriginal` toggle flips which one gets uploaded. A UI-set
  `manualCrop` (straight rect on the original, `POST /api/image/:sha/crop`) overwrites
  `crops/<sha>.jpg` and makes the pipeline's crop phase skip it; the auto crop is kept at
  `crops/<sha>.auto.jpg` for reset.
- **Cropping is optional.** `crop_book.py` uses rembg (`isnet-general-use`, cached in `~/.u2net`) to mask the
  book, then crops the **axis-aligned bounding box** of the (hull-recovered) contour. It NEVER rotates:
  the old `minAreaRect` + `getPerspectiveTransform` deskew turned mask-noise "tilt" on these upright phone
  photos into visibly ROTATED covers (back covers worst — the sticker strip poisons the quad). Any failure falls back to
  `sharp .trim({threshold:150})`. `BSI_SKIP_SAM=1` skips the spawn entirely — tests depend on this.
  The load-bearing ordering: the convex-hull recovery of the fragmented mask must run **before**
  the "foreground too small" bail-out. `image.mjs` does NOT rotate
  crops at all — a blind landscape→portrait `rotate(90)` was turning upright (mostly back) covers on
  their side; EXIF orientation is still normalized via `sharp.rotate()`.
- **A Canny-outline cropper does not work on these scans.** They are angled phone photos, not flat-bed
  scans: the book edge never closes into a 4-corner `RETR_EXTERNAL` contour (61 fragments, largest
  1.4% of frame) and the photo frame itself wins. Don't retry it without new evidence.
- **Python is a batch file protocol, not per-image.** `runPy(script, items)` (`src/py.mjs`) writes
  `job/tmp/<name>-<uuid>.json`, spawns `<python> <script> <in.json> <out.json>`, reads it back, and
  unlinks both files in a `finally`. `pythonLaunch()` returns `py -3` on Windows else `python3`,
  overridable with `PYTHON_BIN`. The pipeline now calls it with a single item per image (book-wise
  streaming), so a spawn failure fails one image and the run continues.
- **Front/back is inferred from barcode presence, not filename** (barcode ⇒ back). The review UI can
  override it per image (`positionOverride`, `POST /api/image/:sha/position`); writeBook's pick treats
  overrides as exclusive (marked-back images can't be picked front), so one click swaps the pair and
  `recomputeBookForImage` refreshes just that book. Pairing is strictly
  by resolved product id; there is no filename-order pairing. Duplicate catalogue titles are
  disambiguated only by the 6-digit shop sticker code (`data/products_6digit.csv`). A sticker code
  that decodes but is missing from that CSV sets `shopCodeUnresolved` (image + book state) and
  clamps any would-be `matched` down to `needs_review` — never silently trust a title match over an
  unknown code. `products_6digit.csv` is maintained out of band; there is no generator script.
- **Commit order is `sortIndex`**, i.e. the alphabetical position of the front file in the folder.
- `job/state.json` is the single source of truth; images keyed by sha, books keyed by
  `p:<productId>` / `t:<normalizedTitle|fileBase>`. `rebuildBooks()` deletes any book it doesn't
  re-see, so it explicitly preserves `chosenProductId`, `createdProductId`, `dismissed`, `enrich`
  and `urls` — extend that preserve-list when adding book fields. A UI `splitKey` on an image
  (`s:<sha12>`, `POST /api/image/:sha/split`) overrides the product-id group key entirely, so a
  wrongly merged back cover becomes its own book; `groupKeyFor` honors it on every rebuild, so
  splits survive re-runs until merged back.
- Folder guard: a loaded `state.json` bound to a different folder makes the CLI exit 1 unless
  `--force` is passed (`src/run.mjs:127`). A `--dry-run` state refuses to commit (`src/commit.mjs:15`).
- Enrichment is Google Books → Open Library → local LM Studio (`LLM_HOST`, default `127.0.0.1:1234`).
  Failures are recorded as `book.enrich.error` rather than thrown, so the next run retries.
- `src/webui.html` is a 51 KB single-file SPA with inline CSS/JS — no build step, no bundler.

## Tests

- `test/image.test.mjs` sets `process.env.BSI_SKIP_SAM = '1'` **before** a top-level dynamic
  `import('../src/image.mjs')`. That ordering is load-bearing; don't hoist the import.
- Tests mock modules with `vi.mock('../src/db.mjs', ...)` and then pull pure helpers back out with
  `await vi.importActual` — follow that pattern instead of restructuring the module for testability.
- `test/enrich.test.mjs` starts real loopback HTTP stub servers and swaps `LLM_HOST`/`LLM_MODEL`
  per test.
- `test/streaming.test.mjs` mocks `image`/`barcode`/`ocr`/`db`/`shopcodes`/`enrich` and asserts the
  *phase order* (`crop, ocr, match, enrich`) for a two-scan folder — it's the regression guard for
  book-wise streaming, so update it if you change the loop order.
- On constrained machines: `NODE_OPTIONS="--max-old-space-size=3072" npm test`.

## Conventions

- ESM `.mjs` only, Node ≥ 18, **no semicolons**, single quotes, 2-space indent.
- Comments only for non-obvious *why*; several files carry real explanatory comments — keep that bar.
- Never hardcode secrets; all config comes from `.env` via `dotenv/config` in `config.mjs` / `web.mjs`.
- Never crash a batch: `console.error`, mark the state entry `failed`, continue.
- `ensureGenres()` must be called on the same client inside the same transaction as the product write.