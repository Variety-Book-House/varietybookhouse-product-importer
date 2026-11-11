import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

vi.mock('../src/db.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchProducts: vi.fn(async () => []) }
})

const { startServer } = await import('../src/web.mjs')

const FRONT = '1'.repeat(64)
const BACK = '2'.repeat(64)

describe('web.mjs /api/image/:sha/split', () => {
  let server
  let base
  let jobDir
  let stateFile

  async function postSplit(sha, action) {
    const res = await fetch(`${base}/api/image/${sha}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    return { status: res.status, data: await res.json() }
  }

  async function readState() {
    return JSON.parse(await readFile(stateFile, 'utf8'))
  }

  beforeAll(async () => {
    jobDir = await mkdtemp(path.join(tmpdir(), 'bsi-split-test-'))
    stateFile = path.join(jobDir, 'state.json')
    const ocr = (title, position) => ({ position, title, author: '', isbn: '', priceText: '', price: null, blurb: '' })
    const state = {
      folder: '/tmp/fake',
      dryRun: false,
      updatedAt: null,
      images: {
        [FRONT]: { sha: FRONT, file: 'a-front.jpg', path: '/tmp/fake/a-front.jpg', status: 'ocr_done', dims: null, ocr: ocr('ALPHA BOOK', 'front') },
        [BACK]: { sha: BACK, file: 'a-back.jpg', path: '/tmp/fake/a-back.jpg', status: 'ocr_done', dims: null, ocr: ocr('alpha book', 'back') },
      },
      books: {},
    }
    await writeFile(stateFile, JSON.stringify(state, null, 2))
    server = await startServer({
      port: 0,
      jobDir,
      checks: {
        ocr: async () => ({ ok: true }),
        db: async () => ({ ok: true }),
        r2: () => ({ ok: true }),
        llm: () => ({ ok: false }),
      },
    })
    base = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(jobDir, { recursive: true, force: true })
  })

  it('splits one image into its own book and re-matches both groups', async () => {
    const { status, data } = await postSplit(BACK, 'out')
    expect(status).toBe(200)
    const splitKey = `s:${BACK.slice(0, 12)}`
    expect(data.keys).toContain(splitKey)
    const state = await readState()
    expect(state.images[BACK].splitKey).toBe(splitKey)
    const grouped = Object.values(state.books).filter((b) => b.front === BACK || b.back === BACK)
    expect(grouped.length).toBe(1)
    expect(grouped[0].key).toBe(splitKey)
    expect(grouped[0].back).toBe(null)
    const shared = state.books['t:alpha book']
    expect(shared).toBeTruthy()
    expect(shared.front).toBe(FRONT)
    expect(shared.back).toBe(null)
    expect(shared.status).toBeTruthy()
    expect(grouped[0].status).toBeTruthy()
  })

  it('cannot split twice but can merge back', async () => {
    expect((await postSplit(BACK, 'out')).status).toBe(409)
    const { status } = await postSplit(BACK, 'merge')
    expect(status).toBe(200)
    const state = await readState()
    expect(state.images[BACK].splitKey).toBe(null)
    expect(state.books[`s:${BACK.slice(0, 12)}`]).toBe(undefined)
    const shared = state.books['t:alpha book']
    expect(shared.front).toBe(FRONT)
    expect(shared.back).toBe(BACK)
  })

  it('rejects bad action and unknown sha', async () => {
    expect((await postSplit(BACK, 'bogus')).status).toBe(400)
    const res = await fetch(`${base}/api/image/${'9'.repeat(64)}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'out' }),
    })
    expect(res.status).toBe(404)
  })
})
