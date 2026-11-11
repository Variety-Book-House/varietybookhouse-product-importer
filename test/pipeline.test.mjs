import { describe, it, expect } from 'vitest'
import { pickTitleFromLines } from '../src/match.mjs'
import { rebuildBooks, refreshBooks, matchBooks, recomputeBookForImage } from '../src/pipeline.mjs'
import { emptyState } from '../src/state.mjs'

function fakeState(images) {
  const state = { ...emptyState(), images, books: {} }
  state.getImage = (sha) => state.images[sha] ?? null
  state.getBook = (key) => state.books[key] ?? null
  state.setBook = (key, fields) => {
    state.books[key] = { key, sortIndex: 0, status: 'needs_review', ...(state.books[key] ?? {}), ...fields }
    return state.books[key]
  }
  return state
}

function image(file, fields) {
  return {
    sha: file,
    file,
    path: `/tmp/${file}`,
    status: 'ocr_done',
    error: null,
    barcode: null,
    productId: null,
    matchMethod: null,
    ocr: null,
    ...fields,
  }
}

describe('book grouping', () => {
  const files = ['a.png', 'b.png', 'c.png']
  const images = {
    'a.png': image('a.png', {
      productId: 'p1',
      matchMethod: 'title',
      barcode: { isbn: '', shopCode: '', raw: [] },
      ocr: { position: 'front', title: 'Alpha', author: 'A', isbn: '', priceText: '', price: 100, blurb: '' },
    }),
    'b.png': image('b.png', {
      productId: 'p1',
      matchMethod: 'shopcode',
      barcode: { isbn: '9781234567897', shopCode: '123456', raw: [{ format: 'EAN_13', text: 'x' }] },
      ocr: { position: 'back', title: '', author: '', isbn: '9781234567897', priceText: '', price: null, blurb: '' },
    }),
    'c.png': image('c.png', {
      barcode: { isbn: '', shopCode: '', raw: [] },
      ocr: { position: 'front', title: 'Beta', author: '', isbn: '', priceText: '', price: null, blurb: '' },
    }),
  }

  it('pairs front and back by resolved product id', () => {
    const state = fakeState(structuredClone(images))
    rebuildBooks(state, files)
    expect(Object.keys(state.books)).toEqual(['p:p1', 't:beta'])
    const book = state.books['p:p1']
    expect(book.front).toBe('a.png')
    expect(book.back).toBe('b.png')
    expect(book.shopCode).toBe('123456')
    expect(book.sortIndex).toBe(0)
  })

  it('incremental refresh matches a full rebuild', () => {
    const full = fakeState(structuredClone(images))
    rebuildBooks(full, files)

    const streamed = fakeState(structuredClone(images))
    streamed.books = {}
    refreshBooks(streamed, files, ['p:p1'])
    expect(Object.keys(streamed.books)).toEqual(['p:p1'])
    expect(streamed.books['p:p1']).toEqual(full.books['p:p1'])

    refreshBooks(streamed, files, ['t:beta'])
    expect(streamed.books).toEqual(full.books)
  })

  it('drops a group once its last image leaves the folder listing', () => {
    const state = fakeState(structuredClone(images))
    rebuildBooks(state, files)
    refreshBooks(state, ['a.png'], ['p:p1'])
    expect(state.books['p:p1'].back).toBe(null)
    refreshBooks(state, ['b.png'], ['p:p1'])
    expect(state.books['p:p1'].front).toBe('b.png')
    refreshBooks(state, ['c.png'], ['t:beta'])
    expect(Object.keys(state.books)).toEqual(['p:p1', 't:beta'])
  })
})

describe('unresolved shop code clamping', () => {
  const products = [{ id: 'p1', title: 'The Great Book', author: 'Jane Doe', mrp: 500, isbn: '' }]

  function bookState(overrides = {}) {
    const state = fakeState({})
    state.setBook('p:p1', {
      title: 'The Great Book',
      author: 'Jane Doe',
      price: 500,
      productId: 'p1',
      shopCode: '194654',
      matchMethod: 'title',
      barcodePresent: true,
      candidates: [],
      ...overrides,
    })
    return state
  }

  it('forces needs_review when the sticker code is absent from the csv', async () => {
    const state = bookState({ shopCodeUnresolved: true })
    await matchBooks(state, { dryRun: false, products, keys: ['p:p1'] })
    expect(state.books['p:p1'].status).toBe('needs_review')
    expect(state.books['p:p1'].matchReason).toContain('sticker code 194654 not in products_6digit.csv')
  })

  it('keeps a confident title match when no sticker code was found', async () => {
    const state = bookState({ shopCodeUnresolved: false, shopCode: '', barcodePresent: false })
    await matchBooks(state, { dryRun: false, products, keys: ['p:p1'] })
    expect(state.books['p:p1'].status).toBe('matched')
  })

  it('carries the flag from images into the rebuilt book', () => {
    const state = fakeState({
      'a.png': image('a.png', {
        productId: 'p1',
        matchMethod: 'title',
        shopCodeUnresolved: true,
        barcode: { isbn: '', shopCode: '194654', raw: [{ format: 'Code 39', text: '194654' }] },
        ocr: { position: 'front', title: 'The Great Book', author: '', isbn: '', priceText: '', price: null, blurb: '' },
      }),
    })
    rebuildBooks(state, ['a.png'])
    expect(state.books['p:p1'].shopCodeUnresolved).toBe(true)
  })
})

describe('position override', () => {
  const pair = {
    'a.png': image('a.png', {
      productId: 'p1',
      matchMethod: 'title',
      barcode: { isbn: '', shopCode: '', raw: [] },
      ocr: { position: 'front', title: 'Alpha', author: '', isbn: '', priceText: '', price: null, blurb: '' },
    }),
    'b.png': image('b.png', {
      productId: 'p1',
      matchMethod: 'shopcode',
      barcode: { isbn: '9781234567897', shopCode: '123456', raw: [{ format: 'EAN_13', text: '9781234567897' }] },
      ocr: { position: 'back', title: '', author: '', isbn: '9781234567897', priceText: '', price: null, blurb: 'B' },
    }),
  }

  it('recomputeBookForImage swaps front/back after an override', () => {
    const images = structuredClone(pair)
    const state = fakeState(images)
    rebuildBooks(state, ['a.png', 'b.png'])
    expect(state.books['p:p1'].front).toBe('a.png')
    expect(state.books['p:p1'].back).toBe('b.png')

    state.images['a.png'].positionOverride = 'back'
    const key = recomputeBookForImage(state, 'a.png')
    expect(key).toBe('p:p1')
    expect(state.books['p:p1'].front).toBe('b.png')
    expect(state.books['p:p1'].back).toBe('a.png')
  })

  it('auto (null) restores the OCR-inferred position', () => {
    const images = structuredClone(pair)
    const state = fakeState(images)
    rebuildBooks(state, ['a.png', 'b.png'])
    state.images['a.png'].positionOverride = 'back'
    recomputeBookForImage(state, 'a.png')
    state.images['a.png'].positionOverride = null
    recomputeBookForImage(state, 'a.png')
    expect(state.books['p:p1'].front).toBe('a.png')
  })

  it('returns null for an unknown or ungroupable image', () => {
    const state = fakeState(structuredClone(pair))
    expect(recomputeBookForImage(state, 'missing')).toBe(null)
    state.images['a.png'].status = 'pending'
    expect(recomputeBookForImage(state, 'a.png')).toBe(null)
  })
})

describe('pickTitleFromLines', () => {
  it('joins vertically adjacent lines of the same block', () => {
    const lines = [
      { text: 'श्रीमद्', conf: 63, box: [63, 52, 292, 188] },
      { text: 'भागवत पुराण', conf: 76, box: [396, 102, 244, 96] },
    ]
    expect(pickTitleFromLines(lines)).toBe('श्रीमद् भागवत पुराण')
  })

  it('keeps a distant author line out of the title', () => {
    const lines = [
      { text: 'THE GREAT BOOK', conf: 90, box: [100, 200, 400, 80] },
      { text: 'JANE DOE', conf: 90, box: [120, 700, 360, 60] },
    ]
    expect(pickTitleFromLines(lines)).toBe('THE GREAT BOOK')
  })

  it('picks the block with the tallest lines', () => {
    const lines = [
      { text: 'SERIES BADGE', conf: 90, box: [10, 10, 100, 20] },
      { text: 'ACTUAL TITLE', conf: 90, box: [50, 300, 500, 120] },
    ]
    expect(pickTitleFromLines(lines)).toBe('ACTUAL TITLE')
  })

  it('skips low-confidence and too-short lines', () => {
    expect(pickTitleFromLines([{ text: 'HIDDEN', conf: 10, box: [0, 0, 10, 10] }])).toBe('')
    expect(pickTitleFromLines([{ text: 'ab', conf: 90, box: [0, 0, 10, 10] }])).toBe('')
    expect(pickTitleFromLines([])).toBe('')
    expect(pickTitleFromLines(null)).toBe('')
  })

  it('orders joined lines top to bottom', () => {
    const lines = [
      { text: 'SECOND', conf: 90, box: [0, 110, 100, 40] },
      { text: 'FIRST', conf: 90, box: [0, 60, 100, 40] },
    ]
    expect(pickTitleFromLines(lines)).toBe('FIRST SECOND')
  })

  it('prefers the romanised form over Devanagari text', () => {
    const lines = [
      { text: 'श्रीमद्', roman: 'Shrimad', conf: 63, box: [63, 52, 355, 240] },
      { text: 'भागवत पुराण', roman: 'Bhagavat Puran', conf: 76, box: [396, 102, 244, 96] },
    ]
    expect(pickTitleFromLines(lines)).toBe('Shrimad Bhagavat Puran')
  })
})
