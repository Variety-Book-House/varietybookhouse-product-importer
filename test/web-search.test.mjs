import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

vi.mock('../src/db.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchProducts: vi.fn(async () => [
      { id: 'p1', title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', mrp: 399, isbn: '9780743273565' },
      { id: 'p2', title: 'Gatsby the Bonus', author: 'Nobody', mrp: 100, isbn: '' },
      { id: 'p3', title: 'Dune', author: 'Frank Herbert', mrp: 500, isbn: '9780441172719' },
    ]),
  }
})

const { startServer } = await import('../src/web.mjs')

describe('web.mjs /api/search', () => {
  let server
  let base
  let jobDir

  beforeAll(async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-search-test-'))
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
    fs.rmSync(jobDir, { recursive: true, force: true })
  })

  it('matches all terms against title/author/isbn and caps the result shape', async () => {
    const res = await fetch(`${base}/api/search?q=gatsby`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.products.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(body.products[0]).toEqual({
      id: 'p1',
      title: 'The Great Gatsby',
      author: 'F. Scott Fitzgerald',
      mrp: 399,
      isbn: '9780743273565',
    })
  })

  it('supports multi-term and isbn-digit queries', async () => {
    const byTerms = await (await fetch(`${base}/api/search?q=frank+dune`)).json()
    expect(byTerms.products.map((p) => p.id)).toEqual(['p3'])
    const byIsbn = await (await fetch(`${base}/api/search?q=9780743273565`)).json()
    expect(byIsbn.products.map((p) => p.id)).toEqual(['p1'])
  })

  it('rejects queries shorter than 2 characters', async () => {
    const res = await fetch(`${base}/api/search?q=d`)
    expect(res.status).toBe(400)
  })

  it('returns 502 when the catalogue snapshot is unavailable', async () => {
    const { fetchProducts } = await import('../src/db.mjs')
    fetchProducts.mockRejectedValueOnce(new Error('snapshot missing'))
    const res = await fetch(`${base}/api/search?q=anywhere`)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('catalogue unavailable')
  })
})
