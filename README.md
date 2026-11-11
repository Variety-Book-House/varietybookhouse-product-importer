# book-scan-importer

Import scanned book covers (front + back) into Variety Book House. Reads the barcode on the back with
**zxing-cpp**, extracts title / price / blurb from both sides with **EasyOCR** (English + Hindi, with
Devanagari → Latin transliteration), and matches against `data/products.json`. Every ISBN found is
also enriched with metadata from **Google Books** (Open Library as fallback) and a **local Ollama
LLM** writes a product description when the provider has none. No cloud LLM required.

## How it works

1. **Barcode** back cover → EAN/ISBN + in-store Code-39 code. ISBN wins and also flips the image
   pair (front/back). A Code-39 that resolves to a product id becomes authoritative for pairing.
2. **OCR** both covers (uncropped originals) → title, price, blurb.
3. **Catalogue match** — title + transliterated Hindi + price against `data/products.json`; barcode
   hits steer the match and group front/back into one book.
4. **ISBN enrichment** — Google Books → Open Library fetch author/publisher/year/pages/categories,
   then a local LLM in **LM Studio** (default `lmstudio-community/Qwen2.5-1.5B-Instruct-MLX-8bit`)
   writes a factual 3–5 sentence description and picks genre tags when the provider has none.
   Results are cached in state; genres are written to the `genres` lookup table (never duplicated)
   before products are committed. 
5. Unmatched scans land in `needs_review` in the web UI, where you confirm or dismiss a candidate,
   then **commit** (Postgres row + R2 thumbnails).

## Prerequisites

- **Node.js ≥ 18** (https://nodejs.org)
- **Python 3.10–3.12** (3.12 recommended for EasyOCR/torch wheels; 3.14+ may be missing wheels)
  - Windows: install from python.org — the `py` launcher is used automatically
  - macOS (Apple Silicon): ensure a normal Python, not just the CLT stub
- **Git**

## Fresh start

Clone and install Node dependencies first:

```sh
git clone <repo-url> book-scan-importer
cd book-scan-importer
npm install
```

Install the Python tools. **macOS / Linux:**

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

**Windows (PowerShell):**

```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

> First EasyOCR run downloads its detection/recognition models automatically (~100 MB).
> If `python3` isn't is_active on PATH, set `PYTHON_BIN` (e.g. `$env:PYTHON_BIN = "py"` on Windows
> PowerShell) — the app auto-detects `py -3` on Windows otherwise.

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```sh
cp .env.example .env        # Windows: copy .env.example .env
```

| Variable                  | Required for | Purpose                                         |
| ------------------------- | ------------ | ----------------------------------------------- |
| `DATABASE_URL`            | matching / commit | Neon Postgres connection for the product catalogue |
| `R2_ACCOUNT_ID` + keys    | commit       | Cloudflare R2 bucket for uploaded thumbnails     |
| `R2_BUCKET` / `R2_PUBLIC_URL` | commit   | R2 bucket name and public base URL               |
| `WEB_PORT`                | optional     | Web UI port (default `4173`)                     |
| `GOOGLE_BOOKS_API_KEY`    | optional     | Free Google Books key — avoids rate limits during enrichment |
| `LLM_HOST`                | optional     | LM Studio local server (default `http://127.0.0.1:1234`) |
| `LLM_MODEL`               | optional     | Model id; empty auto-picks LM Studio's loaded model |

Matches against `data/products.json` (checked into the repo) work without a database. The DB is only
needed for non-dry-run commit.

## Run the pipeline

Dry-run on a folder of scans (does not touch the database):

```sh
node src/run.mjs "/path/to/scans" --dry-run
```

Helpful flags: `--limit N` (first N images), `--force` (re-process everything), `--web` (auto-open
the UI when done), `--no-enrich` (skip the ISBN/LLM enrichment phase).

## ISBN enrichment + descriptions (LM Studio)

The pipeline fetches ISBN metadata automatically. To get machine-written descriptions and genre tags
you need [LM Studio](https://lmstudio.ai) with a loaded model:

1. Install LM Studio and download **`lmstudio-community/Qwen2.5-1.5B-Instruct-MLX-8bit`** (~1 GB,
   runs in ~2 GB RAM — picked for low memory with solid instruction-following).
2. Load the model, then enable the **Local Server** (Developer menu — it listens on port 1234).
3. Leave `LLM_MODEL=` empty in `.env` and the importer auto-picks whatever is loaded; or set it
   explicitly (the id shown in LM Studio's Local Server tab).

`Qwen2.5-1.5B-Instruct-MLX-8bit` is 8-bit quantized — good prose, fits in 8 GB laptops. If you have
16 GB+, `Qwen2.5-3B-Instruct-MLX-8bit` writes noticeably better.

- Descriptions are written in English, 3–5 sentences, based **only** on the fetched metadata and any
  OCR back-cover blurb — nothing invented.
- **Genres** come from Google Books/Open Library categories when present, else the LLM picks up to 3
  (e.g. `Fiction`, `Religion`). On commit, each genre is inserted into the `genres` lookup table
  (`ON CONFLICT DO NOTHING`, so no duplicates) and the deduplicated list goes into the product's
  `genre` array — merged with any existing genres on the row.
- If the provider already ships a description, it is kept as-is (`descriptionSource: "provider"`).
- Google Books is tried first; Open Library is the fallback (no key ever, but rarely has
  descriptions). No result → the enrich entry records an error and is retried on the next run.
- In the web UI the header shows an **LLM** health pill; each card shows the fetched metadata, genre
  chips and the description, with a **"Enrich from ISBN"** button to retry a failed lookup.

## Web UI

```sh
node src/web.mjs
# then open http://localhost:4173
```

- Review `needs_review` books and confirm/dismiss candidate products.
- "Use original" toggles a card's thumbnail between the cropped image and the uncropped original.
- Commit writes books to Postgres and uploads thumbnails to R2.

## Tests

```sh
npm test
```

> On memory-constrained machines use `NODE_OPTIONS="--max-old-space-size=3072" npm test`
> (EasyOCR/crop are skipped in tests via `BSI_SKIP_SAM=1`).

## Optional: background-removal cropping (recommended)

The `crop_book.py` cover-crop uses rembg to mask the book and crops its axis-aligned bounding box —
it never rotates. **Without it the code falls back to a simple `trim()` crop**, which only trims
white — it cannot handle non-white backgrounds. `BSI_SKIP_SAM=1` forces that fallback.

```sh
python -m pip install "rembg[cpu]"
```

The plain `rembg` wheel has no inference backend and raises at `new_session()` — the `[cpu]` extra
pulls onnxruntime. Use `[gpu]` for NVIDIA. The `isnet-general-use` model (~176 MB) downloads to
`~/.u2net` on first run, then everything works offline.

Override the model with `BSI_CROP_MODEL` (e.g. `birefnet-general` for a sharper, slower model).

## Troubleshooting

- **`python3: command not found`** → install Python, or set `PYTHON_BIN=python`
  (Windows: the app already uses the `py` launcher).
- **Header shows `LLM offline`** → LM Studio isn't running or its Local Server is disabled. Enable it
  (Developer menu) and load the model. Enrichment still saves Google Books/Open Library metadata, just
  no generated description/genres.
- **`Enrich from ISBN` keeps failing** → Google Books may be rate-limiting a keyless connection
  (add `GOOGLE_BOOKS_API_KEY`) and the title may be absent from Open Library (common for regional
  Indian titles). Entries auto-retry on the next pipeline run.
- **easyocr fails to import on startup** → the web health badge shows ❌ and details in the browser
  console; re-run `python -m pip install -r requirements.txt`.
- **No barcode read** → check the back cover is a scan with the barcode in frame; zxing is run on the
  uncropped original.
- **Empty titles** → OCR confidence now reports 0–100; if titles are still empty, check the image is
  sharp and upright.
- **Windows PowerShell shows `Activate.ps1` is not digitally signed** → run
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first.