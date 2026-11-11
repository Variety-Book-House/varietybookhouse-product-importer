import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadConfig } from './config.mjs'

const CATALOGUE_PATH = process.env.BSI_CATALOGUE_PATH
  || fileURLToPath(new URL('../data/products.json', import.meta.url))

let pool = null
let catalogue = null

export function getPool() {
  if (!pool) {
    const { ok, errors, config } = loadConfig({ needDb: true })
    if (!ok) throw new Error(errors.join('; '))
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 2,
      idleTimeoutMillis: 30000,
    })
  }
  return pool
}

export async function closePool() {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/**
 * Matching reads the committed catalogue snapshot in data/products.json and
 * never touches the database. The pool is only opened by the commit write
 * path (commitBook / createProduct).
 */
export function catalogueStatus() {
  if (!catalogue) return null
  return {
    rows: catalogue.rows.length,
    fetchedAt: catalogue.fetchedAt,
    source: 'snapshot',
    path: CATALOGUE_PATH,
  }
}

function stampOf(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return null
  }
}

export async function fetchProducts() {
  // memoise by file mtime: an out-of-band `scripts/snapshot-products.mjs` run (or an
  // appendCatalogue rewrite) must be picked up by a long-lived web server without a restart
  const stamp = stampOf(CATALOGUE_PATH)
  if (catalogue && catalogue.stamp === stamp) return catalogue.rows
  if (stamp === null) {
    if (catalogue) return catalogue.rows
    throw new Error(
      `catalogue snapshot missing at ${CATALOGUE_PATH} — run scripts/snapshot-products.mjs to generate it`,
    )
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(CATALOGUE_PATH, 'utf8'))
  } catch (e) {
    if (catalogue) return catalogue.rows
    throw new Error(`catalogue snapshot is unreadable at ${CATALOGUE_PATH}: ${e.message}`)
  }
  if (!Array.isArray(raw?.products)) {
    if (catalogue) return catalogue.rows
    throw new Error(`catalogue snapshot has no "products" array at ${CATALOGUE_PATH}`)
  }
  catalogue = { rows: raw.products, fetchedAt: raw.fetchedAt ?? null, stamp }
  return catalogue.rows
}

/**
 * Appends a freshly created product to the catalogue: the memoised in-memory
 * rows (so /api/search and later matching see it without a restart) and
 * data/products.json (so it survives one). Never reads the products table —
 * the row comes straight from the create call. When the snapshot file is
 * missing or corrupt the in-memory rows still gain the product but the file
 * is NOT rewritten: a partial file would silently mask the
 * "snapshot missing → everything degrades to needs_review" signal, and the
 * fix for that is regenerating via scripts/snapshot-products.mjs.
 */
export async function appendCatalogue({ id, title, author, mrp, isbn }) {
  let snapshotted = true
  let rows
  try {
    rows = await fetchProducts()
  } catch {
    if (!catalogue) catalogue = { rows: [], fetchedAt: null, stamp: stampOf(CATALOGUE_PATH) }
    rows = catalogue.rows
    snapshotted = false
  }
  const row = {
    id,
    title: title ?? '',
    author: author ?? '',
    mrp: mrp ?? null,
    isbn: isbn ?? '',
  }
  if (!rows.some((r) => String(r.id) === String(id))) rows.push(row)
  catalogue.fetchedAt = new Date().toISOString()
  if (snapshotted) {
    const tmp = `${CATALOGUE_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: catalogue.fetchedAt, count: rows.length, products: rows }))
    fs.renameSync(tmp, CATALOGUE_PATH)
  }
  return row
}

export function mergePairs(newImages, newThumbnails, oldImages, oldThumbnails, placement = 'front') {
  // Pairs are merged deduped ONLY on the detail URL: the thumbnail always travels
  // with its own image (null when unknown) so `images` and `thumbnails` stay
  // index-aligned. `placement` says where THIS commit's covers go: 'front'
  // prepends (new front cover leads both arrays), 'back' appends after the
  // existing rows — so a back-only book committed after its front never
  // hijacks index 0.
  const newPairs = (newImages ?? []).map((img, i) => [img, newThumbnails?.[i] ?? null])
  const oldPairs = (oldImages ?? []).map((img, i) => [img, oldThumbnails?.[i] ?? null])
  const pairs = placement === 'back' ? [...oldPairs, ...newPairs] : [...newPairs, ...oldPairs]
  const seen = new Set()
  const images = []
  const thumbnails = []
  for (const [img, thumb] of pairs) {
    if (img == null || seen.has(img)) continue
    seen.add(img)
    images.push(img)
    thumbnails.push(thumb ?? null)
  }
  return { images, thumbnails }
}

export function mergeGenres(existing, incoming) {
  const seen = new Set()
  const out = []
  for (const list of [existing, incoming]) {
    for (const raw of list ?? []) {
      const g = String(raw ?? '').trim()
      if (!g) continue
      const key = g.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(g)
    }
  }
  return out
}

/**
 * Ensures every genre name exists in the `genres` lookup table exactly once
 * (unique on the genre column; ON CONFLICT skips existing rows so nothing is
 * inserted twice). MUST be called inside a transaction (same client).
 */
export async function ensureGenres(client, genres) {
  for (const raw of genres ?? []) {
    const g = String(raw ?? '').trim()
    if (!g) continue
    await client.query('INSERT INTO genres (genre) VALUES ($1) ON CONFLICT (genre) DO NOTHING', [g])
  }
}

export async function commitBook({ productId, newImages, newThumbnails, isbn, genre = [], orientation = 'portrait', placement = 'front' }) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT images, thumbnails, genre FROM products WHERE id = $1 FOR UPDATE`,
      [productId],
    )
    if (rows.length === 0) throw new Error(`product ${productId} not found`)
    const merged = mergePairs(newImages ?? [], newThumbnails ?? [], rows[0].images ?? [], rows[0].thumbnails ?? [], placement)
    const mergedGenre = mergeGenres(rows[0].genre, genre)
    await ensureGenres(client, mergedGenre)
    await client.query(
      `UPDATE products SET images = $1, thumbnails = $2, "ISBN" = COALESCE("ISBN", $3), genre = $4 WHERE id = $5`,
      [merged.images, merged.thumbnails, isbn ?? null, mergedGenre, productId],
    )
    await client.query('COMMIT')
    return { images: merged.images, thumbnails: merged.thumbnails, genre: mergedGenre }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { })
    throw e
  } finally {
    client.release()
  }
}

export async function createProduct({ title, author, mrp, isbn, images, thumbnails, genres = [] }) {
  const genresClean = genres ?? []
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await ensureGenres(client, genresClean)
    const { rows } = await client.query(
      `INSERT INTO products (title, author, mrp, "ISBN", images, thumbnails, stock, is_active, genre)
       VALUES ($1, $2, $3, $4, $5, $6, 0, true, $7) RETURNING id`,
      [title, author ?? null, mrp, isbn ?? null, images ?? [], thumbnails ?? [], genresClean],
    )
    await client.query('COMMIT')
    return rows[0].id
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { })
    throw e
  } finally {
    client.release()
  }
}
