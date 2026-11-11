import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import {
  cleanGenres,
  fetchGoogleBooks,
  fetchOpenLibrary,
  fetchBookMeta,
  generateContent,
  enrichBook,
  llmStatus,
} from '../src/enrich.mjs'
import { enrichBooks } from '../src/pipeline.mjs'

const ISBN = '9788128807244'
const MODEL = 'lmstudio-community/Qwen2.5-1.5B-Instruct-MLX-8bit'

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
function port(server) {
  return server.address().port
}
function json(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

let google, ol, lmstudio
beforeAll(async () => {
  google = await listen((req, res) => {
    const m = /q=isbn:([0-9]+)/.exec(decodeURIComponent(req.url || ''))
    const isbn = m ? m[1] : ''
    if (isbn === '9780000000002') {
      return json(res, {
        items: [{ volumeInfo: { title: 'A Plain Book', authors: ['No One'], publishedDate: '2012' } }],
      })
    }
    if (isbn === '9780040000000') return json(res, {})
    if (isbn === '9780321594471') return json(res, {})
    if (!isbn) return json(res, {})
    return json(res, {
      items: [
        {
          volumeInfo: {
            title: 'The Enriching Book',
            authors: ['Alice Author', 'Bob B'],
            publisher: 'Great Press',
            publishedDate: '2019-03',
            pageCount: 240,
            categories: ['Fiction', 'Novel'],
            description: 'An official publisher description of great length.',
          },
        },
      ],
    })
  })
  ol = await listen((req, res) => {
    const url = decodeURIComponent(req.url || '')
    if (!url.includes('bibkeys=ISBN:9780321594471')) return json(res, {})
    json(res, {
      'ISBN:9780321594471': {
        title: 'Only Library Book',
        authors: [{ name: 'Carol Writer' }],
        publishers: [{ name: 'Open Library Pubs' }],
        publish_date: '2001',
        number_of_pages: 111,
        subjects: [{ name: 'History' }],
        cover: { medium: 'https://covers.example/1-M.jpg' },
      },
    })
  })
  lmstudio = await listen((req, res) => {
    if (req.url === '/v1/models') {
      return json(res, { data: [{ id: MODEL }, { id: 'llama3.2:3b' }] })
    }
    if (req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const payload = JSON.parse(body)
        if (!payload.model || !String(payload.model).includes('Qwen2.5-1.5B-Instruct-MLX-8bit')) {
          return json(res, { error: 'unknown model' }, 404)
        }
        const content = JSON.stringify({
          description: 'A clean generated description from the local model.',
          genres: ['Fiction', 'Religion'],
        })
        json(res, { choices: [{ message: { content } }] })
      })
      return
    }
    json(res, { error: 'not found' }, 404)
  })
})

afterAll(() => {
  google.close()
  ol.close()
  lmstudio.close()
})

const opts = () => ({
  host: `http://127.0.0.1:${port(google)}`,
  llmHost: `http://127.0.0.1:${port(lmstudio)}`,
  model: MODEL,
})

describe('fetchGoogleBooks', () => {
  it('parses metadata incl. description, year and pages', async () => {
    const meta = await fetchGoogleBooks(ISBN, opts())
    expect(meta.provider).toBe('google')
    expect(meta.title).toBe('The Enriching Book')
    expect(meta.authors).toEqual(['Alice Author', 'Bob B'])
    expect(meta.year).toBe('2019')
    expect(meta.pageCount).toBe(240)
    expect(meta.categories).toContain('Fiction')
    expect(meta.description).toContain('publisher description')
  })

  it('returns meta without description when provider has none', async () => {
    const meta = await fetchGoogleBooks('9780000000002', opts())
    expect(meta.title).toBe('A Plain Book')
    expect(meta.description).toBe('')
  })

  it('returns null when the provider has no record', async () => {
    expect(await fetchGoogleBooks('9780040000000', { ...opts(), apiKey: 'k' })).toBeNull()
  })
})

describe('fetchOpenLibrary', () => {
  it('parses metadata with no description', async () => {
    const meta = await fetchOpenLibrary('9780321594471', { host: `http://127.0.0.1:${port(ol)}` })
    expect(meta.provider).toBe('openlibrary')
    expect(meta.title).toBe('Only Library Book')
    expect(meta.authors).toEqual(['Carol Writer'])
    expect(meta.publisher).toBe('Open Library Pubs')
    expect(meta.year).toBe('2001')
    expect(meta.pageCount).toBe(111)
    expect(meta.description).toBe('')
  })
})

describe('fetchBookMeta', () => {
  it('uses google when available', async () => {
    const meta = await fetchBookMeta(ISBN, opts())
    expect(meta.provider).toBe('google')
  })

  it('falls back to openlibrary when google has no record', async () => {
    const meta = await fetchBookMeta('9780321594471', {
      googleHost: `http://127.0.0.1:${port(google)}`,
      openLibraryHost: `http://127.0.0.1:${port(ol)}`,
    })
    expect(meta.provider).toBe('openlibrary')
  })

  it('returns null for an invalid isbn', async () => {
    expect(await fetchBookMeta('not-an-isbn', opts())).toBeNull()
  })
})

describe('generateContent', () => {
  it('returns the JSON description and genres parsed from LM Studio', async () => {
    const book = { isbn: ISBN, blurb: 'back cover text' }
    const meta = { title: 'X', authors: ['Y'], provider: 'google' }
    const out = await generateContent(book, meta, opts())
    expect(out.description).toBe('A clean generated description from the local model.')
    expect(out.genres).toEqual(['Fiction', 'Religion'])
    expect(out.model).toBe(MODEL)
  })

  it('falls back to an installed model when the configured one is unknown', async () => {
    const out = await generateContent(
      { isbn: ISBN },
      { title: 'X', authors: [] },
      { host: `http://127.0.0.1:${port(lmstudio)}`, model: 'bogus-model', timeout: 2000 },
    )
    expect(out).not.toBeNull()
    expect(out.model).toBe(MODEL)
  })

  it('returns null when the LLM server is unreachable', async () => {
    const out = await generateContent(
      { isbn: ISBN },
      { title: 'X', authors: [] },
      { host: 'http://127.0.0.1:1', model: MODEL, timeout: 2000 },
    )
    expect(out).toBeNull()
  })
})

describe('enrichBook', () => {
  it('keeps provider description and maps provider categories to genres (no LLM call)', async () => {
    const enrich = await enrichBook({ isbn: ISBN, title: 'The Enriching Book', blurb: '' }, opts())
    expect(enrich.provider).toBe('google')
    expect(enrich.description).toContain('publisher description')
    expect(enrich.descriptionSource).toBe('provider')
    expect(enrich.descriptionModel).toBeNull()
    expect(enrich.genres).toEqual(['Fiction', 'Novel'])
  })

  it('generates a description AND genres via LLM when provider has neither', async () => {
    const enrich = await enrichBook({ isbn: '9780000000002', title: 'A Plain Book', blurb: '' }, opts())
    expect(enrich.descriptionSource).toBe('generated')
    expect(enrich.description).toContain('generated description')
    expect(enrich.descriptionModel).toBe(MODEL)
    expect(enrich.genres).toEqual(['Fiction', 'Religion'])
  })

  it('records an error when no metadata is found', async () => {
    const enrich = await enrichBook({ isbn: ISBN, title: 'x' }, { ...opts(), host: 'http://127.0.0.1:1' })
    expect(enrich.error).toBeTruthy()
  })

  it('records an error when generation fails but metadata was found', async () => {
    const enrich = await enrichBook(
      { isbn: '9780000000002', title: 'A Plain Book', blurb: '' },
      { host: `http://127.0.0.1:${port(google)}`, llmHost: 'http://127.0.0.1:1', model: MODEL, timeout: 2000 },
    )
    expect(enrich.provider).toBe('google')
    expect(enrich.descriptionSource).toBe('none')
    expect(enrich.error).toContain('LM Studio')
  })

  it('returns null for an invalid isbn', async () => {
    expect(await enrichBook({ isbn: '', title: 'x' }, opts())).toBeNull()
  })
})

describe('cleanGenres', () => {
  it('trims, dedupes case-insensitively and caps at 4 entries', () => {
    expect(
      cleanGenres([' fiction ', 'Fiction', 'Religion', 'Religion', 'Xx', 'Aa', 'Bb', 'Cc', 'Dd', 'Ee']),
    ).toEqual(['fiction', 'Religion', 'Xx', 'Aa'])
  })

  it('handles non-array input', () => {
    expect(cleanGenres(null)).toEqual([])
    expect(cleanGenres('Fiction')).toEqual([])
  })
})

describe('llmStatus', () => {
  it('reports reachable server and installed model', async () => {
    process.env.LLM_HOST = `http://127.0.0.1:${port(lmstudio)}`
    process.env.LLM_MODEL = MODEL
    const s = await llmStatus()
    expect(s.ok).toBe(true)
    expect(s.hasModel).toBe(true)
    expect(s.model).toBe(MODEL)
    delete process.env.LLM_HOST
    delete process.env.LLM_MODEL
  })

  it('reports unreachable', async () => {
    process.env.OLLAMA_HOST = undefined
    process.env.LLM_HOST = 'http://127.0.0.1:1'
    const s = await llmStatus()
    expect(s.ok).toBe(false)
    expect(s.error).toBeTruthy()
    delete process.env.LLM_HOST
  })
})

describe('pipeline enrichBooks', () => {
  const progress = { start() {}, setMessage() {}, advance() {} }

  it('skips books without an isbn and skips already-enriched books', async () => {
    const books = {
      a: { isbn: '', enrich: null },
      b: { isbn: ISBN, enrich: { description: 'have it', error: null } },
      c: { isbn: ISBN, enrich: null },
    }
    const saved = []
    const state = {
      books,
      setBook(key, fields) { Object.assign(this.books[key], fields) },
      save() { saved.push(true) },
    }
    const enriched = []
    const enrichFn = async (book) => { enriched.push(book.isbn); return { description: 'made' } }
    const done = await enrichBooks(state, { progress, enrichFn })
    expect(done).toBe(1)
    expect(enriched).toEqual([ISBN])
    expect(state.books.c.enrich.description).toBe('made')
    expect(state.books.b.enrich.description).toBe('have it')
    expect(saved.length).toBe(1)
  })

  it('retries books with a prior enrich error and records new errors', async () => {
    const state = {
      books: {
        a: { isbn: ISBN, enrich: { error: 'old' } },
        b: { isbn: ISBN, enrich: null },
      },
      setBook(key, fields) { Object.assign(this.books[key], fields) },
      save() {},
    }
    const calls = []
    const enrichFn = async (book) => { calls.push(book.isbn); return { error: 'still down' } }
    await enrichBooks(state, { progress, enrichFn })
    expect(calls).toEqual([ISBN, ISBN])
    expect(state.books.a.enrich.error).toBe('still down')
    expect(state.books.b.enrich.error).toBe('still down')
  })

  it('does nothing when runEnrich is false', async () => {
    const state = { books: { a: { isbn: ISBN } }, setBook() {}, save() {} }
    const enrichFn = async () => { throw new Error('should not be called') }
    expect(await enrichBooks(state, { progress, enrichFn, runEnrich: false })).toBe(0)
  })
})