import fs from 'node:fs'
import path from 'node:path'
import { sha256, cropWhiteBg, toOriginalJpeg, safeName } from './image.mjs'
import { readBarcodes } from './barcode.mjs'
import { runOcr } from './ocr.mjs'
import { resolveShopCode } from './shopcodes.mjs'
import { enrichBook, enrichDefaults } from './enrich.mjs'
import {
  normalize,
  isValidIsbn,
  scoreCandidate,
  rankBooks,
  decide,
  decideUnavailable,
  classifyBarcodes,
  bestTitleMatchLines,
  priceFromLines,
  blurbFromLines,
  pickTitleFromLines,
} from './match.mjs'
import { fetchProducts } from './db.mjs'
import { startProgress, endProgress } from './progress.mjs'

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i

const PHASE_ORDER = ['crop', 'ocr', 'match', 'enrich']

// With book-wise streaming a phase boundary is a gate inside the per-image loop rather than a
// separate pass, so --stop-at still means "run every image up to this phase, then stop".
function phaseAllowed(stopAt, phase) {
  if (!stopAt || stopAt === 'complete') return true
  const stopIndex = PHASE_ORDER.indexOf(stopAt)
  return stopIndex === -1 || PHASE_ORDER.indexOf(phase) <= stopIndex
}

export function discoverImages(folder) {
  const files = []

  function walk(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = path.join(prefix, entry.name)
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile() && IMAGE_EXT.test(entry.name)) files.push(rel)
    }
  }

  walk(folder)
  return files.sort()
}

function findIsbn(lines) {
  for (const line of lines ?? []) {
    const digits = String(line.text ?? '').replace(/[^0-9Xx]/g, '')
    for (let i = 0; i + 13 <= digits.length; i++) {
      const cand = digits.slice(i, i + 13)
      if (isValidIsbn(cand)) return cand
    }
    if (digits.length === 10 && isValidIsbn(digits)) return digits
  }
  return ''
}

const GROUPED_STATUSES = new Set(['ocr_done', 'committed'])

function groupKeyFor(entry, file) {
  if (!entry || !GROUPED_STATUSES.has(entry.status)) return null
  // UI "split as another book" pins the image to its own group
  if (entry.splitKey) return entry.splitKey
  return entry.productId
    ? `p:${entry.productId}`
    : `t:${entry.ocr?.title ? normalize(entry.ocr.title) : safeName(file)}`
}

function buildGroups(state, files) {
  const entryByFile = new Map()
  for (const entry of Object.values(state.images)) {
    if (entry.file) entryByFile.set(entry.file, entry)
  }
  const indexByFile = new Map(files.map((f, i) => [f, i]))
  const groups = new Map()
  for (const file of files) {
    const entry = entryByFile.get(file)
    const key = groupKeyFor(entry, file)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  return { groups, indexByFile }
}

function writeBook(state, key, list, indexByFile) {
  // Effective position = manual override from the UI, else barcode-inferred OCR position.
  // Overrides are exclusive: an image explicitly marked 'back' can never be picked
  // as front (and vice versa), so clicking one slot swaps the pair without needing
  // two clicks.
  const pos = (x) => x.positionOverride ?? x.ocr?.position
  const frontPool = list.filter((x) => x.positionOverride !== 'back')
  const front = frontPool.find((x) => pos(x) === 'front') ?? frontPool[0] ?? list[0]
  const back =
    list.find((x) => x.positionOverride !== 'front' && x.sha !== front.sha && pos(x) === 'back') ??
    null
  const ocrF = front.ocr
  const ocrB = back?.ocr
  const title = ocrF?.title || ocrB?.title || ''
  const shopCode = list.map((x) => x.barcode?.shopCode).find(Boolean) ?? ''
  const shopCodeUnresolved = list.some((x) => x.shopCodeUnresolved)
  const productId = front.productId ?? back?.productId ?? null
  const barcodePresent = list.some((x) => (x.barcode?.raw?.length ?? 0) > 0)
  const old = state.getBook(key)
  const preserved = old
    ? {
        chosenProductId: old.chosenProductId ?? null,
        createdProductId: old.createdProductId ?? null,
        dismissed: old.dismissed ?? false,
        commitError: old.commitError ?? null,
        urls: old.urls ?? null,
        enrich: old.enrich ?? null,
      }
    : {}
  state.setBook(key, {
    sortIndex: indexByFile.get(front.file) ?? 0,
    title,
    author: ocrF?.author || ocrB?.author || '',
    isbn: isValidIsbn(ocrF?.isbn) ? ocrF.isbn : isValidIsbn(ocrB?.isbn) ? ocrB.isbn : '',
    price: ocrF?.price ?? ocrB?.price ?? null,
    priceText: ocrF?.priceText || ocrB?.priceText || '',
    blurb: ocrF?.blurb || ocrB?.blurb || '',
    front: front.sha,
    back: back ? back.sha : null,
    productId,
    shopCode,
    shopCodeUnresolved,
    matchMethod: front.matchMethod ?? back?.matchMethod ?? null,
    barcodePresent,
    ...preserved,
    ...(old && (old.status === 'committed' || old.status === 'created') ? { status: old.status } : {}),
  })
}

export function rebuildBooks(state, files) {
  const { groups, indexByFile } = buildGroups(state, files)
  const seen = new Set()
  for (const [key, list] of groups) {
    writeBook(state, key, list, indexByFile)
    seen.add(key)
  }
  for (const key of Object.keys(state.books)) {
    if (!seen.has(key)) delete state.books[key]
  }
}

// Streaming counterpart of rebuildBooks: recompute only the groups an image just joined,
// so a book can be matched and enriched the moment it is complete instead of at end of run.
export function refreshBooks(state, files, keys) {
  const { groups, indexByFile } = buildGroups(state, files)
  for (const key of keys) {
    const list = groups.get(key)
    if (list) writeBook(state, key, list, indexByFile)
    else delete state.books[key]
  }
}

// Recomputes just the book an image belongs to after its front/back position
// was manually overridden. Files are re-derived from the image entries because
// the UI has no folder listing — group keys don't depend on position, so the
// image stays in the same group; only the front/back pick inside it changes.
export function recomputeBookForImage(state, sha) {
  const img = state.getImage(sha)
  if (!img) return null
  const key = groupKeyFor(img, img.file)
  if (!key) return null
  const files = Object.values(state.images)
    .map((e) => e.file)
    .filter(Boolean)
    .sort()
  refreshBooks(state, files, [key])
  return key
}

// Sets (or clears, with null) an image's manual split key and recomputes BOTH the
// group it left and the group it joined. Returns the affected book keys; empty
// when the image isn't groupable yet.
export function splitImage(state, sha, splitKey) {
  const img = state.getImage(sha)
  if (!img) return []
  const files = Object.values(state.images)
    .map((e) => e.file)
    .filter(Boolean)
    .sort()
  const oldKey = groupKeyFor(img, img.file)
  img.splitKey = splitKey
  const newKey = groupKeyFor(img, img.file)
  if (!oldKey && !newKey) return []
  const keys = [...new Set([oldKey, newKey].filter(Boolean))]
  refreshBooks(state, files, keys)
  return keys
}

export async function matchBooks(state, { dryRun, progress = null, keys = null, products: loaded } = {}) {
  let products = loaded
  if (products === undefined) {
    if (!dryRun) {
      if (progress) progress.start('match', { total: 0, message: 'loading catalogue' })
      try {
        products = await fetchProducts()
      } catch (e) {
        products = null
        console.error(`catalogue unavailable, matching disabled: ${e.message}`)
      }
    } else {
      products = null
    }
  }
  const selected = (keys ?? Object.keys(state.books)).filter(
    (key) =>
      state.books[key] && state.books[key].status !== 'committed' && state.books[key].status !== 'created',
  )
  if (progress) progress.start('match', { total: selected.length })
  for (const key of selected) {
    const book = state.books[key]
    if (progress) progress.setMessage(book.title || key)
    if (dryRun || products === null) {
      const d = decideUnavailable()
      state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates: [] })
    } else if (book.productId) {
      const product = products.find((p) => p.id === book.productId)
      if (!product) {
        state.setBook(key, {
          status: 'needs_review',
          score: 0,
          matchReason: 'resolved product id missing from catalogue snapshot',
          candidates: [],
        })
      } else {
        const r = scoreCandidate(product, book)
        const candidates = [
          {
            id: product.id,
            title: product.title ?? '',
            author: product.author ?? '',
            mrp: product.mrp,
            isbn: product.isbn ?? '',
            score: Math.round(r.score * 100) / 100,
            titleScore: Math.round(r.titleScore * 100) / 100,
            mrpMatch: r.mrpMatch,
            authorMatch: r.authorMatch,
            swapped: r.swapped,
          },
        ]
        let d
        const priceConflict =
          book.price != null && product.mrp != null && Number(product.mrp) !== Number(book.price)
        if (book.matchMethod === 'shopcode' && priceConflict) {
          d = {
            status: 'needs_review',
            score: candidates[0].score,
            reason: `shop code ${book.shopCode} matched but price differs (scan ₹${book.price}, catalogue ₹${product.mrp})`,
          }
        } else if (book.matchMethod === 'shopcode') {
          d = { status: 'matched', score: candidates[0].score, reason: `shop code ${book.shopCode} → catalogue` }
        } else {
          d = decide(candidates, book)
        }
        if (book.barcodePresent && d.status === 'unmatched') {
          d = {
            status: 'needs_review',
            score: d.score,
            reason: 'barcode found but no confident catalogue match',
          }
        }
        if (book.shopCodeUnresolved && d.status === 'matched') {
          d = {
            status: 'needs_review',
            score: d.score,
            reason: `sticker code ${book.shopCode} not in products_6digit.csv — ${d.reason}`,
          }
        }
        if (book.price == null && product.mrp != null && d.status === 'matched') {
          state.setBook(key, { price: Number(product.mrp) })
        }
        state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates })
      }
    } else {
      const candidates = rankBooks(products, book)
      let d = decide(candidates, book)
      if (book.barcodePresent && d.status === 'unmatched') {
        d = { status: 'needs_review', score: d.score, reason: 'barcode found but no confident catalogue match' }
      }
      if (book.shopCodeUnresolved && d.status === 'matched') {
        d = {
          status: 'needs_review',
          score: d.score,
          reason: `sticker code ${book.shopCode} not in products_6digit.csv — ${d.reason}`,
        }
      }
      state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates })
    }
    if (progress) progress.advance()
  }
}

export async function enrichBooks(state, { progress = null, enrichFn = enrichBook, runEnrich = true, keys = null } = {}) {
  if (!runEnrich) return 0
  const selected = keys ?? Object.keys(state.books)
  if (selected.length > 0 && progress) {
    progress.start('enrich', { total: selected.length, message: 'ISBN metadata + descriptions' })
  }
  let done = 0
  for (const key of selected) {
    const book = state.books[key]
    if (!book) {
      if (progress) progress.advance()
      continue
    }
    if (progress) progress.setMessage(book.title || key)
    if (!isValidIsbn(book.isbn) || (book.enrich && !book.enrich.error)) {
      if (progress) progress.advance()
      continue
    }
    try {
      const enrich = await enrichFn(book)
      if (enrich) state.setBook(key, { enrich })
      done++
    } catch (e) {
      state.setBook(key, { enrich: { error: e.message, generatedAt: new Date().toISOString() } })
    }
    if (progress) progress.advance()
  }
  if (selected.length > 0) state.save()
  return done
}

export async function orchestrate({ folder, dryRun = false, limit = 0, state, retryFailed = false, autoEnrich = true, progress: given = null, stopAt }) {
  const progress = given ?? startProgress({ label: folder, phase: 'discover', total: 0 })
  let result = null
  try {
    result = await run({ folder, dryRun, limit, state, retryFailed, autoEnrich, progress, stopAt })
    return result
  } finally {
    if (!given) {
      endProgress(
        progress,
        result ? `${result.processed} processed, ${result.failed} failed` : 'stopped',
      )
    }
  }
}

async function run({ folder, dryRun, limit, state, retryFailed, autoEnrich, progress, stopAt }) {
  if (state.folder && state.folder !== folder) {
    throw new Error('state belongs to another folder; use --force')
  }
  state.folder = folder
  state.dryRun = dryRun

  if (state.stopRequested) {
    console.log('stop requested — exiting pipeline early')
    state.save()
    return { processed: 0, failed: 0, books: state.books }
  }

  progress.start('discover', { total: 0, message: folder })
  const files = discoverImages(folder)
  const cropsDir = path.join(state.jobDir, 'crops')
  const originalsDir = path.join(state.jobDir, 'originals')

  const work = []
  for (const file of files) {
    const abs = path.join(folder, file)
    const buf = fs.readFileSync(abs)
    const sha = sha256(buf)
    let entry = state.getImage(sha)
    if (!entry || entry.path !== abs) {
      entry = state.addImage(sha, { file, path: abs, status: 'pending' })
    }
    progress.setMessage(file)
    progress.advance()
    if (entry.status === 'ocr_done' || entry.status === 'committed') continue
    if (entry.status === 'failed') {
      if (!retryFailed) continue
      state.setImage(sha, { status: 'pending', error: null })
    }
    work.push({ file, abs, buf, entry })
  }
  progress.start('discover', { total: files.length })

  if (limit > 0) work.length = Math.min(work.length, limit)

  let processed = 0
  let failed = 0

  let catalogue = null
  if (!dryRun) {
    try {
      catalogue = await fetchProducts()
    } catch (e) {
      console.error(`catalogue snapshot unavailable: ${e.message}`)
    }
  }

  const bookEstimate = Math.max(1, Math.ceil(work.length / 2))
  progress.schedule([
    { phase: 'crop', total: work.length },
    { phase: 'ocr', total: work.length },
    { phase: 'match', total: bookEstimate },
    { phase: 'enrich', total: bookEstimate },
  ])

  const finalized = new Set()

  const finalizeBook = async (key) => {
    if (finalized.has(key)) return
    finalized.add(key)
    const label = state.books[key]?.title || key
    progress.start('match', { message: label })
    await matchBooks(state, { dryRun, keys: [key], products: dryRun ? null : catalogue })
    progress.step()
    if (autoEnrich && phaseAllowed(stopAt, 'enrich')) {
      progress.start('enrich', { message: label })
      await enrichBooks(state, { keys: [key] })
      progress.step()
    }
    state.save()
  }

  for (let i = 0; i < work.length; i++) {
    const { file, buf, entry } = work[i]
    const label = `[${i + 1}/${work.length}] ${file}`
    const cropPath = path.join(cropsDir, `${entry.sha}.jpg`)
    const originalPath = path.join(originalsDir, `${entry.sha}.jpg`)

    progress.start('crop', { total: work.length, message: file })
    try {
      // a UI-set manual crop is user data: re-running the pipeline must not clobber it
      const manual = entry.manualCrop && fs.existsSync(cropPath)
      if (!manual && (!entry.dims || !fs.existsSync(cropPath))) {
        const crop = await cropWhiteBg(buf)
        fs.mkdirSync(cropsDir, { recursive: true })
        fs.writeFileSync(cropPath, crop.buffer)
        state.setImage(entry.sha, { dims: { width: crop.width, height: crop.height } })
      }
      if (!fs.existsSync(originalPath)) {
        const original = await toOriginalJpeg(buf)
        fs.mkdirSync(originalsDir, { recursive: true })
        fs.writeFileSync(originalPath, original)
      }
      state.setImage(entry.sha, { status: 'cropped', error: null })
      state.save()
      progress.step()
    } catch (e) {
      const error = `crop: ${e.message}`
      state.setImage(entry.sha, { status: 'failed', error })
      state.save()
      failed++
      progress.log(`${label} → FAILED ${error}`)
      progress.step({ ok: false })
      continue
    }

    if (!phaseAllowed(stopAt, 'ocr')) continue

    progress.start('ocr', { total: work.length, message: file })
    try {
      const barcodeMap = await readBarcodes([{ id: entry.sha, path: originalPath }])
      const raw = barcodeMap.get(entry.sha) ?? []
      const { isbn: barcodeIsbn, shopCode } = classifyBarcodes(raw)
      state.setImage(entry.sha, { barcode: { isbn: barcodeIsbn, shopCode, raw } })

      const linesMap = await runOcr([{ id: entry.sha, path: originalPath }])
      const lines = linesMap.get(entry.sha) ?? []
      const position = raw.length > 0 ? 'back' : 'front'
      const { price, priceText } = priceFromLines(lines)

      let title = ''
      let author = ''
      let productId = null
      let matchMethod = null
      if (catalogue) {
        if (shopCode) {
          const hit = resolveShopCode(shopCode, catalogue)
          if (hit) {
            productId = hit.product.id
            matchMethod = 'shopcode'
            title = hit.product.title ?? ''
            author = hit.product.author ?? ''
          }
        }
        if (!productId) {
          let hit = bestTitleMatchLines(lines, catalogue, 95)
          if (!hit && lines.some((l) => l.roman)) {
            hit = bestTitleMatchLines(lines.filter((l) => l.roman), catalogue, 85)
          }
          if (hit) {
            productId = hit.product.id
            matchMethod = 'title'
            title = hit.product.title ?? ''
            author = hit.product.author ?? ''
          }
        }
      }
      if (!title) title = pickTitleFromLines(lines)

      const isbn = barcodeIsbn || findIsbn(lines)
      const blurb = position === 'back' ? blurbFromLines(lines, title) : ''
      const ocr = { position, title, author, isbn, priceText, price, blurb }
      const shopCodeUnresolved = !!catalogue && !!shopCode && matchMethod !== 'shopcode'
      state.setImage(entry.sha, { status: 'ocr_done', ocr, productId, matchMethod, shopCodeUnresolved, error: null })
      state.save()
      processed++
      const bits = [
        position,
        shopCode ? `code ${shopCode}${shopCodeUnresolved ? ' (not in csv)' : ''}` : null,
        isbn ? `isbn ${isbn}` : null,
        price != null ? `₹${price}` : null,
        productId ? `→ ${productId}` : null,
        `"${title}"`,
      ].filter(Boolean)
      progress.log(`${label} → ${bits.join(' ')}`)
      progress.step()
    } catch (e) {
      const error = `scan: ${e.message}`
      state.setImage(entry.sha, { status: 'failed', error })
      state.save()
      failed++
      progress.log(`${label} → FAILED ${error}`)
      progress.step({ ok: false })
      continue
    }

    const key = groupKeyFor(state.getImage(entry.sha), file)
    if (key) refreshBooks(state, files, [key])

    if (!phaseAllowed(stopAt, 'match')) continue
    const book = key ? state.getBook(key) : null
    if (book?.front && book?.back) await finalizeBook(key)
  }

  if (!phaseAllowed(stopAt, 'match')) {
    state.save()
    return { processed, failed, books: state.books }
  }

  rebuildBooks(state, files)
  const bookTotal = Object.keys(state.books).length
  progress.setPlanTotal('match', bookTotal)
  progress.setPlanTotal('enrich', bookTotal)
  for (const key of Object.keys(state.books)) {
    if (!finalized.has(key)) await finalizeBook(key)
  }

  state.save()
  return { processed, failed, books: state.books }
}
