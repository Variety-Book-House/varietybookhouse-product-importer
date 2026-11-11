import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dir

async function freshDb() {
  vi.resetModules()
  return import('../src/db.mjs')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-cat-'))
  process.env.BSI_CATALOGUE_PATH = path.join(dir, 'products.json')
})

afterEach(() => {
  delete process.env.BSI_CATALOGUE_PATH
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('appendCatalogue', () => {
  it('adds the row to memory and rewrites the snapshot file', async () => {
    fs.writeFileSync(process.env.BSI_CATALOGUE_PATH, JSON.stringify({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      count: 1,
      products: [{ id: 'p1', title: 'Old', author: 'A', mrp: 10, isbn: '' }],
    }))
    const db = await freshDb()
    const rows = await db.fetchProducts()
    expect(rows.length).toBe(1)
    await db.appendCatalogue({ id: 'p2', title: 'New', author: null, mrp: null, isbn: '978123' })
    expect(await db.fetchProducts()).toEqual([
      { id: 'p1', title: 'Old', author: 'A', mrp: 10, isbn: '' },
      { id: 'p2', title: 'New', author: '', mrp: null, isbn: '978123' },
    ])
    const onDisk = JSON.parse(fs.readFileSync(process.env.BSI_CATALOGUE_PATH, 'utf8'))
    expect(onDisk.count).toBe(2)
    expect(onDisk.products.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(onDisk.fetchedAt).not.toBe('2026-01-01T00:00:00.000Z')
  })

  it('dedupes by id', async () => {
    fs.writeFileSync(process.env.BSI_CATALOGUE_PATH, JSON.stringify({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      count: 1,
      products: [{ id: 'p1', title: 'Old', author: '', mrp: null, isbn: '' }],
    }))
    const db = await freshDb()
    await db.fetchProducts()
    await db.appendCatalogue({ id: 'p1', title: 'Dup', author: '', mrp: null, isbn: '' })
    const rows = await db.fetchProducts()
    expect(rows.length).toBe(1)
    expect(rows[0].title).toBe('Old')
  })

  it('keeps memory-only when the snapshot file is missing', async () => {
    const db = await freshDb()
    await expect(db.fetchProducts()).rejects.toThrow(/snapshot missing/)
    const row = await db.appendCatalogue({ id: 'p9', title: 'X', author: '', mrp: 5, isbn: '' })
    expect(row.id).toBe('p9')
    const rows = await db.fetchProducts()
    expect(rows.map((r) => r.id)).toEqual(['p9'])
    expect(fs.existsSync(process.env.BSI_CATALOGUE_PATH)).toBe(false)
  })

  it('does not overwrite a corrupt snapshot file', async () => {
    fs.writeFileSync(process.env.BSI_CATALOGUE_PATH, 'not json{{{')
    const db = await freshDb()
    await expect(db.fetchProducts()).rejects.toThrow(/unreadable/)
    await db.appendCatalogue({ id: 'p9', title: 'X', author: '', mrp: 5, isbn: '' })
    expect(fs.readFileSync(process.env.BSI_CATALOGUE_PATH, 'utf8')).toBe('not json{{{')
    const rows = await db.fetchProducts()
    expect(rows.map((r) => r.id)).toEqual(['p9'])
  })
})
