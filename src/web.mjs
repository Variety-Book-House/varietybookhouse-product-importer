import 'dotenv/config'
import http from 'node:http'
import { readFile, writeFile, rename, stat, mkdir, readdir, copyFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getProgress } from './progress.mjs'
import { pythonLaunch } from './py.mjs'
import { enrichBook, llmStatus, enrichDefaults } from './enrich.mjs'
import { isValidIsbn } from './match.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultJobDir = path.resolve(here, '..', 'job')
const webuiPath = path.join(here, 'webui.html')

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

function httpError(message, status) {
  const err = new Error(message)
  err.status = status
  return err
}

async function loadState(jobDir) {
  try {
    const raw = await readFile(path.join(jobDir, 'state.json'), 'utf8')
    const state = JSON.parse(raw)
    if (!state.images || typeof state.images !== 'object') state.images = {}
    if (!state.books || typeof state.books !== 'object') state.books = {}
    return state
  } catch (err) {
    if (err.code === 'ENOENT') return { folder: '', dryRun: false, updatedAt: null, images: {}, books: {} }
    throw err
  }
}

async function saveState(jobDir, state) {
  state.updatedAt = new Date().toISOString()
  const file = path.join(jobDir, 'state.json')
  const tmp = `${file}.tmp-${process.pid}`
  await mkdir(jobDir, { recursive: true })
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, file)
}

function computeCounts(state) {
  const books = Object.values(state.books || {})
  const images = Object.values(state.images || {})
  return {
    matched: books.filter((b) => b.status === 'matched' || b.status === 'created').length,
    review: books.filter((b) => b.status === 'needs_review').length,
    unmatched: books.filter((b) => b.status === 'unmatched').length,
    committed: books.filter((b) => b.status === 'committed').length,
    failedImages: images.filter((i) => i.status === 'failed').length,
  }
}

async function browseDir(dir) {
  try {
    const resolved = path.resolve(dir)
    const entries = await readdir(resolved, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const hasImages = await dirHasImages(resolved)
    return { dir: resolved, dirs, hasImages }
  } catch {
    return { dir: path.resolve(dir), dirs: [], hasImages: false }
  }
}

async function dirHasImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isFile() && IMAGE_EXT.test(entry.name)) return true
    if (entry.isDirectory() && await dirHasImages(abs)) return true
  }
  return false
}

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i

let jobInProgress = false
let ocrCheckPromise = null
let llmCheckPromise = null

function defaultChecks() {
  return {
    ocr: () => {
      if (!ocrCheckPromise) {
        ocrCheckPromise = (async () => {
          const { spawnSync } = await import('node:child_process')
          const root = path.resolve(here, '..')
          const missing = ['read_barcodes.py', 'ocr_batch.py', 'crop_book.py'].filter(
            (f) => !existsSync(path.join(root, f)),
          )
          if (missing.length) return { ok: false, missing }
          const { cmd: pyCmd, pre: pyPre } = pythonLaunch()
          const probe = spawnSync(pyCmd, [...pyPre, '-c', 'import zxingcpp, cv2, easyocr, indic_transliteration, rembg'], { timeout: 60000 })
          if (probe.status !== 0) {
            return { ok: false, error: String(probe.stderr ?? '').slice(-300) || 'python imports failed' }
          }
          return { ok: true }
        })().catch((e) => ({ ok: false, error: e.message }))
      }
      return ocrCheckPromise
    },
    db: async () => {
      const configured = Boolean(process.env.DATABASE_URL)
      try {
        const { fetchProducts, catalogueStatus } = await import('./db.mjs')
        const products = await fetchProducts()
        return { ok: configured && products.length > 0, configured, catalogue: catalogueStatus() }
      } catch (e) {
        return { ok: false, configured, error: e.message }
      }
    },
    r2: () => {
      const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL']
      return { ok: required.every((name) => process.env[name]) }
    },
    llm: () => {
      if (!llmCheckPromise) {
        llmCheckPromise = llmStatus().finally(() => {
          setTimeout(() => { llmCheckPromise = null }, 15000)
        })
      }
      return llmCheckPromise
    },
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw httpError('payload too large', 413)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw httpError('invalid JSON body', 400)
  }
}

async function serveImage(res, jobDir, sha, src = 'crop') {
  const primary = path.join(jobDir, src === 'orig' ? 'originals' : 'crops', `${sha}.jpg`)
  const secondary = path.join(jobDir, src === 'orig' ? 'crops' : 'originals', `${sha}.jpg`)
  let file = primary
  try {
    await stat(primary)
  } catch {
    file = secondary
  }
  let info
  try {
    info = await stat(file)
  } catch {
    throw httpError('image not found', 404)
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-cache',
    'Content-Length': info.size,
  })
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

async function handleBookAction(req, res, ctx, key, action) {
  const state = await loadState(ctx.jobDir)
  const book = state.books[key]
  if (!book) throw httpError(`book not found: ${key}`, 404)
  const body = await readJsonBody(req)

  if (action === 'enrich') {
    if (!isValidIsbn(book.isbn)) throw httpError('book has no ISBN to look up', 400)
    const enrich = await enrichBook(book)
    book.enrich = enrich
    await saveState(ctx.jobDir, state)
    return sendJson(res, 200, { ok: true, book })
  }

  if (action === 'confirm') {
    const productId = typeof body.productId === 'string' ? body.productId.trim() : ''
    if (!productId) throw httpError('productId (string) is required', 400)
    book.chosenProductId = productId
    book.status = 'matched'
    book.dismissed = false
    await saveState(ctx.jobDir, state)
    return sendJson(res, 200, { ok: true, book })
  }

  if (action === 'dismiss') {
    if (book.status === 'committed') throw httpError('book is already committed', 409)
    book.dismissed = body.undo === true ? false : true
    await saveState(ctx.jobDir, state)
    return sendJson(res, 200, { ok: true, book })
  }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const author = typeof body.author === 'string' ? body.author.trim() : ''
  const isbn = typeof body.isbn === 'string' ? body.isbn.replace(/[\s-]/g, '') : ''
  let mrp = null
  if (body.mrp !== undefined && body.mrp !== null && String(body.mrp).trim() !== '') {
    mrp = Number(body.mrp)
    if (!Number.isFinite(mrp) || mrp <= 0) throw httpError('mrp must be a positive number', 400)
  }
  if (!title) throw httpError('title is required', 400)

  let id
  try {
    const { createProduct } = await import('./db.mjs')
    const created = await createProduct({
      title,
      author,
      mrp,
      isbn,
      genres: book.enrich?.genres ?? [],
      images: [],
      thumbnails: [],
    })
    id = typeof created === 'string' ? created : created?.id ?? created
  } catch (err) {
    throw httpError(`createProduct failed: ${err.message}`, 502)
  }
  if (!id) throw httpError('createProduct returned no id', 502)
  book.createdProductId = String(id)
  book.status = 'created'
  await saveState(ctx.jobDir, state)
  // the product now exists in Postgres; fold it into the catalogue snapshot too so
  // /api/search and later scans can match against it without re-running the snapshot script
  let catalogueError = null
  try {
    const { appendCatalogue } = await import('./db.mjs')
    await appendCatalogue({ id: String(id), title, author, mrp, isbn })
  } catch (err) {
    catalogueError = err.message
    console.error(`catalogue append failed for product ${id}: ${err.message}`)
  }
  return sendJson(res, 200, { ok: true, book, ...(catalogueError ? { catalogueError } : {}) })
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (req.method === 'GET' && p === '/') {
    let html
    try {
      html = await readFile(webuiPath, 'utf8')
    } catch {
      throw httpError('webui.html not found', 404)
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    return res.end(html)
  }

  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true })

  if (req.method === 'GET' && p === '/api/progress') {
    return sendJson(res, 200, { progress: getProgress() })
  }

  let m
  if (req.method === 'GET' && (m = p.match(/^\/img\/([a-f0-9]{64})$/i))) {
    const src = url.searchParams.get('src') === 'orig' ? 'orig' : 'crop'
    return serveImage(res, ctx.jobDir, m[1].toLowerCase(), src)
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/image\/([a-f0-9]{64})\/source$/))) {
    const sha = m[1].toLowerCase()
    const body = await readJsonBody(req)
    const source = body.source === 'original' ? 'original' : 'crop'
    const state = await loadState(ctx.jobDir)
    const img = state.images[sha]
    if (!img) throw httpError('image not found', 404)
    img.useOriginal = source === 'original'
    await saveState(ctx.jobDir, state)
    return sendJson(res, 200, { ok: true, sha, source })
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/image\/([a-f0-9]{64})\/position$/))) {
    const sha = m[1].toLowerCase()
    const body = await readJsonBody(req)
    const raw = body.position
    if (raw !== 'front' && raw !== 'back' && raw !== 'auto') throw httpError("position must be 'front', 'back' or 'auto'", 400)
    const { JobState } = await import('./state.mjs')
    const { recomputeBookForImage } = await import('./pipeline.mjs')
    const jobState = new JobState(ctx.jobDir).load()
    const img = jobState.getImage(sha)
    if (!img) throw httpError('image not found', 404)
    img.positionOverride = raw === 'auto' ? null : raw
    const bookKey = recomputeBookForImage(jobState, sha)
    jobState.save()
    return sendJson(res, 200, { ok: true, sha, position: raw, bookKey })
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/image\/([a-f0-9]{64})\/crop$/))) {
    const sha = m[1].toLowerCase()
    const body = await readJsonBody(req)
    const { JobState } = await import('./state.mjs')
    const sharp = (await import('sharp')).default
    const jobState = new JobState(ctx.jobDir).load()
    const img = jobState.getImage(sha)
    if (!img) throw httpError('image not found', 404)
    const cropsDir = path.join(ctx.jobDir, 'crops')
    const cropPath = path.join(cropsDir, `${sha}.jpg`)
    const autoPath = path.join(cropsDir, `${sha}.auto.jpg`)

    if (body.reset === true) {
      if (!img.manualCrop) throw httpError('no manual crop to reset', 400)
      let restored = false
      try {
        await stat(autoPath)
        await copyFile(autoPath, cropPath)
        const info = await sharp(cropPath).metadata()
        jobState.setImage(sha, { manualCrop: null, dims: { width: info.width, height: info.height } })
        restored = true
      } catch {
        jobState.setImage(sha, { manualCrop: null })
      }
      jobState.save()
      return sendJson(res, 200, { ok: true, sha, manualCrop: null, restored, v: Date.now() })
    }

    const origPath = path.join(ctx.jobDir, 'originals', `${sha}.jpg`)
    let ow, oh
    try {
      const info = await sharp(origPath).metadata()
      ow = info.width
      oh = info.height
      // a browser auto-rotates by EXIF; mirror that so fractions match what the UI shows
      const swap = info.orientation >= 5 && info.orientation <= 8
      if (swap) [ow, oh] = [oh, ow]
    } catch {
      throw httpError('original image not found — run the scan pipeline first', 404)
    }
    const fr = ['x0', 'y0', 'x1', 'y1'].map((k) => Number(body[k]))
    if (fr.some((v) => !Number.isFinite(v))) throw httpError('x0, y0, x1, y1 (0..1 fractions) are required', 400)
    const clamp01 = (v) => Math.min(Math.max(v, 0), 1)
    const fx0 = clamp01(Math.min(fr[0], fr[2]))
    const fx1 = clamp01(Math.max(fr[0], fr[2]))
    const fy0 = clamp01(Math.min(fr[1], fr[3]))
    const fy1 = clamp01(Math.max(fr[1], fr[3]))
    const left = Math.round(fx0 * ow)
    const top = Math.round(fy0 * oh)
    let width = Math.round(fx1 * ow) - left
    let height = Math.round(fy1 * oh) - top
    if (width < 16 || height < 16) throw httpError('crop too small (min 16px)', 400)
    width = Math.min(width, ow - left)
    height = Math.min(height, oh - top)
    await mkdir(cropsDir, { recursive: true })
    // keep the auto crop recoverable: first manual crop backs it up once
    try {
      await stat(cropPath)
      await stat(autoPath).catch(async () => { await copyFile(cropPath, autoPath) })
    } catch { /* no existing crop to back up */ }
    const tmp = `${cropPath}.tmp-${process.pid}`
    // .rotate() FIRST so extract runs in the EXIF-upright space the UI preview shows
    await sharp(origPath)
      .rotate()
      .extract({ left, top, width, height })
      .jpeg({ quality: 90 })
      .toFile(tmp)
    await rename(tmp, cropPath)
    const manualCrop = { x0: left / ow, y0: top / oh, x1: (left + width) / ow, y1: (top + height) / oh }
    jobState.setImage(sha, { manualCrop, dims: { width, height } })
    jobState.save()
    return sendJson(res, 200, { ok: true, sha, manualCrop, dims: { width, height }, v: Date.now() })
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/image\/([a-f0-9]{64})\/split$/))) {
    const sha = m[1].toLowerCase()
    const body = await readJsonBody(req)
    const action = body.action
    if (action !== 'out' && action !== 'merge') throw httpError("action must be 'out' or 'merge'", 400)
    const { JobState } = await import('./state.mjs')
    const { splitImage, matchBooks } = await import('./pipeline.mjs')
    const jobState = new JobState(ctx.jobDir).load()
    const img = jobState.getImage(sha)
    if (!img) throw httpError('image not found', 404)
    if (img.status === 'committed') throw httpError('image is already committed', 409)
    if (action === 'out') {
      if (img.splitKey) throw httpError('image is already split into its own book', 409)
      const keys = splitImage(jobState, sha, `s:${sha.slice(0, 12)}`)
      if (keys.length === 0) throw httpError('image is not part of a detected book yet', 400)
      jobState.save()
      await matchBooks(jobState, { dryRun: jobState.dryRun, keys })
      jobState.save()
      return sendJson(res, 200, { ok: true, sha, action, keys })
    }
    if (!img.splitKey) throw httpError('image is not split', 400)
    const staleKey = img.splitKey
    const keys = splitImage(jobState, sha, null)
    if (!keys.includes(staleKey)) keys.push(staleKey)
    jobState.save()
    await matchBooks(jobState, { dryRun: jobState.dryRun, keys })
    jobState.save()
    return sendJson(res, 200, { ok: true, sha, action, keys })
  }

  if (req.method === 'GET' && p === '/api/state') {
    const state = await loadState(ctx.jobDir)
    const [ocr, db, r2, llm] = await Promise.all([ctx.checks.ocr(), ctx.checks.db(), ctx.checks.r2(), ctx.checks.llm()])
    const books = Object.values(state.books).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    return sendJson(res, 200, {
      folder: state.folder ?? null,
      dryRun: Boolean(state.dryRun),
      ocr,
      db,
      r2,
      llm,
      enrichModel: enrichDefaults().model,
      counts: computeCounts(state),
      progress: getProgress(),
      books,
      images: Object.values(state.images),
    })
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/book\/([^/]+)\/(confirm|dismiss|create|enrich)$/))) {
    return handleBookAction(req, res, ctx, decodeURIComponent(m[1]), m[2])
  }

  if (req.method === 'POST' && p === '/api/commit') {
    const loaded = await loadState(ctx.jobDir)
    const { JobState } = await import('./state.mjs')
    const { commitConfirmed } = await import('./commit.mjs')
    const jobState = new JobState(ctx.jobDir)
    jobState.state = loaded
    const results = await commitConfirmed({ state: jobState })
    await saveState(ctx.jobDir, jobState.stateData)
    return sendJson(res, 200, { results })
  }

  if (req.method === 'POST' && p === '/api/retry') {
    if (jobInProgress) throw httpError('a job is already running', 409)
    jobInProgress = true
    try {
      const state = await loadState(ctx.jobDir)
      if (!state.folder) throw httpError('no folder selected yet', 400)
      const { JobState } = await import('./state.mjs')
      const pipeline = await import('./pipeline.mjs')
      const jobState = new JobState(ctx.jobDir).load()
      let retried
      if (typeof pipeline.retryFailed === 'function') {
        retried = await pipeline.retryFailed(jobState)
      } else {
        retried = await pipeline.orchestrate({
          folder: jobState.folder,
          dryRun: jobState.dryRun,
          limit: 0,
          state: jobState,
          retryFailed: true,
        })
      }
      await saveState(ctx.jobDir, jobState.stateData)
      return sendJson(res, 200, { ok: true, retried })
    } finally {
      jobInProgress = false
    }
  }

  if (req.method === 'GET' && p === '/api/browse') {
    const url = new URL(req.url, 'http://localhost')
    const dir = url.searchParams.get('path') || process.cwd()
    const result = await browseDir(dir)
    return sendJson(res, 200, result)
  }

  if (req.method === 'GET' && p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    if (q.length < 2) throw httpError('q (2+ chars) is required', 400)
    let products
    try {
      const { fetchProducts } = await import('./db.mjs')
      products = await fetchProducts()
    } catch (e) {
      throw httpError(`catalogue unavailable: ${e.message}`, 502)
    }
    const terms = q.split(/\s+/).filter(Boolean)
    const hits = []
    for (const p2 of products) {
      const hay = `${p2.title ?? ''} ${p2.author ?? ''} ${String(p2.isbn ?? '').replace(/[^0-9x]/gi, '')}`
        .toLowerCase()
      if (terms.every((t) => hay.includes(t))) {
        hits.push({ id: p2.id, title: p2.title ?? '', author: p2.author ?? '', mrp: p2.mrp, isbn: p2.isbn ?? '' })
        if (hits.length >= 25) break
      }
    }
    return sendJson(res, 200, { products: hits })
  }

  if (req.method === 'POST' && p === '/api/start-job') {
    if (jobInProgress) throw httpError('a job is already running', 409)
    jobInProgress = true
    try {
      const body = await readJsonBody(req)
      const requested = typeof body.folder === 'string' ? body.folder.trim() : ''
      if (!requested) throw httpError('folder is required', 400)
      const folder = path.resolve(requested)
      let st
      try {
        st = await stat(folder)
      } catch {
        throw httpError('folder not found', 404)
      }
      if (!st.isDirectory()) throw httpError('not a directory', 400)

      const { loadConfig } = await import('./config.mjs')
      const { discoverImages, orchestrate } = await import('./pipeline.mjs')
      const { JobState } = await import('./state.mjs')

      const images = discoverImages(folder)
      if (images.length === 0) throw httpError('no images found in folder', 400)

      const { ok, errors } = loadConfig({ needDb: false, needR2: false })
      if (!ok) throw httpError('Missing config: ' + errors.join(', '), 500)

      const state = new JobState(ctx.jobDir)
      state.reset(folder, false)

      try {
        await orchestrate({
          folder,
          dryRun: false,
          limit: 0,
          state,
          retryFailed: false,
        })
      } catch (err) {
        console.error('orchestrate error:', err)
        throw err
      }

      return sendJson(res, 200, { ok: true, folder, imageCount: images.length })
    } finally {
      jobInProgress = false
    }
  }

  if (req.method === 'POST' && p === '/api/stop-job') {
    if (jobInProgress) throw httpError('a job is already running', 409)
    jobInProgress = true
    try {
      const state = await loadState(ctx.jobDir)
      state.stopRequested = true
      await saveState(ctx.jobDir, state)
      return sendJson(res, 200, { ok: true })
    } catch (e) {
      console.error('stop job error:', e)
      throw httpError('failed to stop job: ' + e.message, 500)
    } finally {
      jobInProgress = false
    }
  }

  throw httpError('not found', 404)
}

export function startServer({ port, jobDir = defaultJobDir, checks = {} } = {}) {
  const listenPort = port ?? (Number(process.env.WEB_PORT || 4173) || 4173)
  const ctx = { jobDir, checks: { ...defaultChecks(), ...checks } }
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || String(err) })
      else res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      console.error(`web: listen failed: ${err.message}`)
      if (isDirectRun()) process.exit(1)
      reject(err)
    })
    server.listen(listenPort, () => {
      const actual = server.address()?.port ?? listenPort
      console.log(`Book Scan Importer UI: http://localhost:${actual}`)
      resolve(server)
    })
  })
}

if (isDirectRun()) {
  const args = process.argv.slice(2)
  let port
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[i + 1])
    else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7))
  }
  startServer(port !== undefined && Number.isFinite(port) ? { port } : {}).catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
