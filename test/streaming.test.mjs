import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CATALOGUE = [{ id: 'p1', title: 'The Alpha Book', author: 'Ann Author', mrp: 100, isbn: '9781234567897' }]

const OCR_LINES = {
  front: [
    { text: 'THE ALPHA BOOK', conf: 90, box: [10, 10, 400, 60] },
    { text: 'ANN AUTHOR', conf: 90, box: [10, 90, 300, 40] },
    { text: 'ISBN 978-1-234-567-89-7', conf: 40, box: [10, 700, 200, 30] },
  ],
  back: [
    { text: 'a blurb line', conf: 80, box: [10, 10, 400, 60] },
  ],
}

vi.mock('../src/image.mjs', () => ({
  sha256: (buf) => `sha-${String(buf)}`,
  cropWhiteBg: async () => ({ buffer: Buffer.from('crop'), width: 100, height: 200 }),
  toOriginalJpeg: async () => Buffer.from('original'),
  safeName: (s) => String(s).replace(/\.[^.]+$/, '').toLowerCase(),
}))

vi.mock('../src/db.mjs', () => ({
  fetchProducts: async () => CATALOGUE,
  closePool: async () => {},
}))

vi.mock('../src/shopcodes.mjs', () => ({
  resolveShopCode: (code) =>
    code === '123456'
      ? { name: 'The Alpha Book', product: CATALOGUE[0], score: 100, exact: true }
      : null,
}))

vi.mock('../src/barcode.mjs', () => ({
  readBarcodes: async (items) => {
    const map = new Map()
    for (const item of items) {
      const back = item.id === 'sha-back'
      map.set(item.id, back ? [{ format: 'EAN_13', text: '123456', valid: true }] : [])
    }
    return map
  },
}))

vi.mock('../src/ocr.mjs', () => ({
  runOcr: async (items) => {
    const map = new Map()
    for (const item of items) map.set(item.id, item.id === 'sha-back' ? OCR_LINES.back : OCR_LINES.front)
    return map
  },
}))

const enrichCalls = []
vi.mock('../src/enrich.mjs', () => ({
  enrichDefaults: () => ({ model: 'test-model' }),
  enrichBook: async (book) => {
    enrichCalls.push(book.title)
    return { provider: 'google', description: 'desc', genres: [], generatedAt: new Date().toISOString() }
  },
}))

const { orchestrate } = await import('../src/pipeline.mjs')
const { JobState } = await import('../src/state.mjs')

function recorder() {
  const phases = []
  return {
    phases,
    schedule: () => {},
    setPlanTotal: () => {},
    start(phase, opts = {}) {
      phases.push(`${phase}:${opts.message ?? ''}`)
    },
    setMessage: () => {},
    step: () => {},
    advance: () => {},
    log: () => {},
  }
}

function makeScanDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-stream-'))
  fs.writeFileSync(path.join(dir, '01-front.png'), 'front')
  fs.writeFileSync(path.join(dir, '02-back.png'), 'back')
  return dir
}

describe('orchestrate — book-wise streaming', () => {
  beforeEach(() => {
    enrichCalls.length = 0
  })

  it('finishes one book (crop → barcode → ocr → match → enrich) before starting the next', async () => {
    const scanDir = makeScanDir()
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-job-'))
    const progress = recorder()

    const result = await orchestrate({
      folder: scanDir,
      dryRun: false,
      limit: 0,
      state: new JobState(jobDir).load(),
      retryFailed: false,
      autoEnrich: true,
      progress,
    })

    expect(result.processed).toBe(2)
    expect(result.failed).toBe(0)

    const order = progress.phases.map((p) => p.split(':')[0])
    expect(order).toEqual(['discover', 'discover', 'crop', 'ocr', 'crop', 'ocr', 'match', 'enrich'])

    // the back scan completes the book, so match+enrich run mid-stream, not at the end
    expect(progress.phases.filter((p) => p.startsWith('enrich'))).toHaveLength(1)
    expect(enrichCalls).toEqual(['The Alpha Book'])

    const books = Object.values(result.books)
    expect(books).toHaveLength(1)
    expect(books[0].front).toBe('sha-front')
    expect(books[0].back).toBe('sha-back')
    expect(books[0].shopCode).toBe('123456')
    expect(books[0].isbn).toBe('9781234567897')
    expect(books[0].status).toBe('matched')
    expect(books[0].enrich.description).toBe('desc')

    fs.rmSync(scanDir, { recursive: true, force: true })
    fs.rmSync(jobDir, { recursive: true, force: true })
  })

  it('saves state and exits cleanly (no ReferenceError after the stream)', async () => {
    const scanDir = makeScanDir()
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-job-'))
    const state = new JobState(jobDir).load()

    await orchestrate({
      folder: scanDir,
      dryRun: false,
      limit: 0,
      state,
      retryFailed: false,
      autoEnrich: false,
      progress: recorder(),
    })

    const saved = JSON.parse(fs.readFileSync(path.join(jobDir, 'state.json'), 'utf8'))
    expect(Object.keys(saved.images)).toHaveLength(2)
    expect(Object.keys(saved.books)).toHaveLength(1)

    fs.rmSync(scanDir, { recursive: true, force: true })
    fs.rmSync(jobDir, { recursive: true, force: true })
  })

  it('--stop-at ocr groups books but never matches or enriches them', async () => {
    const scanDir = makeScanDir()
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-job-'))

    const result = await orchestrate({
      folder: scanDir,
      dryRun: false,
      limit: 0,
      state: new JobState(jobDir).load(),
      retryFailed: false,
      autoEnrich: true,
      progress: recorder(),
      stopAt: 'ocr',
    })

    expect(result.processed).toBe(2)
    expect(enrichCalls).toEqual([])
    const books = Object.values(result.books)
    expect(books).toHaveLength(1)
    expect(books[0].status).toBe('needs_review')
    expect(books[0].candidates).toEqual([])
    expect(books[0].enrich).toBe(null)

    fs.rmSync(scanDir, { recursive: true, force: true })
    fs.rmSync(jobDir, { recursive: true, force: true })
  })
})