import { isValidIsbn } from './match.mjs'

const DEFAULT_LLM_HOST = 'http://127.0.0.1:1234'
const DEFAULT_LLM_MODEL = 'lmstudio-community/Qwen2.5-1.5B-Instruct-MLX-8bit'
const MAX_GENRES = 4

export function enrichDefaults() {
  return {
    googleKey: process.env.GOOGLE_BOOKS_API_KEY || '',
    host: process.env.LLM_HOST || DEFAULT_LLM_HOST,
    model: process.env.LLM_MODEL || DEFAULT_LLM_MODEL,
  }
}

export function cleanGenres(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const g = String(raw ?? '').trim()
    if (g.length < 2) continue
    const key = g.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(g)
    if (out.length >= MAX_GENRES) break
  }
  return out
}

async function fetchJson(url, { timeout = 8000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function cleanAuthors(v) {
  return Array.isArray(v?.authors) ? v.authors.map((a) => (typeof a === 'string' ? a : a?.name ?? '')).filter(Boolean) : []
}

function yearFrom(dateText) {
  const m = /(20\d{2}|19\d{2})/.exec(String(dateText ?? ''))
  return m ? m[1] : ''
}

export async function fetchGoogleBooks(isbn, { apiKey = '', host = 'https://www.googleapis.com', timeout = 8000 } = {}) {
  const key = typeof apiKey === 'string' && apiKey ? apiKey : (process.env.GOOGLE_BOOKS_API_KEY || '')
  const url = `${host}/books/v1/volumes?q=${encodeURIComponent('isbn:' + isbn)}${key ? `&key=${encodeURIComponent(key)}` : ''}`
  const json = await fetchJson(url, { timeout })
  const info = json?.items?.[0]?.volumeInfo
  if (!info) return null
  return {
    provider: 'google',
    title: info.title ?? '',
    authors: cleanAuthors(info),
    publisher: info.publisher ?? '',
    year: yearFrom(info.publishedDate),
    pageCount: Number(info.pageCount) || 0,
    categories: Array.isArray(info.categories) ? info.categories : [],
    description: typeof info.description === 'string' ? info.description.trim() : '',
    coverThumb: info.imageLinks?.thumbnail ?? '',
  }
}

export async function fetchOpenLibrary(isbn, { host = 'https://openlibrary.org', timeout = 8000 } = {}) {
  const json = await fetchJson(`${host}/api/books?bibkeys=${encodeURIComponent('ISBN:' + isbn)}&jscmd=data&format=json`, { timeout })
  const rec = json?.[`ISBN:${isbn}`]
  if (!rec) return null
  return {
    provider: 'openlibrary',
    title: rec.title ?? '',
    authors: cleanAuthors({ authors: rec.authors }),
    publisher: Array.isArray(rec.publishers) ? rec.publishers.map((p) => p?.name ?? '').filter(Boolean).join(', ') : '',
    year: yearFrom(rec.publish_date),
    pageCount: Number(rec.number_of_pages) || 0,
    categories: Array.isArray(rec.subjects) ? rec.subjects.map((s) => s?.name ?? '').filter(Boolean) : [],
    description: '',
    coverThumb: rec.cover?.medium ?? '',
  }
}

export async function fetchBookMeta(isbn, opts = {}) {
  if (!isValidIsbn(isbn)) return null
  const googleOpts = { ...opts, host: opts.googleHost || opts.host || 'https://www.googleapis.com' }
  const olOpts = { ...opts, host: opts.openLibraryHost || opts.host || 'https://openlibrary.org' }
  const meta = await fetchGoogleBooks(isbn, googleOpts) ?? await fetchOpenLibrary(isbn, olOpts)
  if (!meta) return null
  return meta
}

const SYSTEM_PROMPT =
  'You write concise, factually accurate product descriptions for a bookstore catalogue. ' +
  'Never invent plot details, reviews, or awards. Base every claim only on the provided metadata and OCR blurb.'

function buildPrompt(meta, book) {
  const facts = {
    Title: meta.title || book.title || '',
    Author: Array.isArray(meta.authors) ? meta.authors.join(', ') : '',
    Publisher: meta.publisher || '',
    Year: meta.year || '',
    Pages: meta.pageCount || '',
    Category: Array.isArray(meta.categories) ? meta.categories.join(', ') : (meta.provider === 'openlibrary' ? '' : ''),
    ISBN: book.isbn || meta.isbn || '',
  }
  const lines = Object.entries(facts).map(([k, v]) => (v ? `- ${k}: ${v}` : null)).filter(Boolean)
  const blurb = String(book.blurb ?? '').trim()
  return (
    'Write a 3–5 sentence English product description (250–450 characters) for this book. ' +
    'Also pick at most 3 short genre tags (e.g. "Fiction", "Religion", "Children") supported by the metadata.\n\n' +
    'Metadata:\n' +
    lines.join('\n') +
    (blurb ? `\n\nBack-cover OCR blurb to use as inspiration:\n"${blurb}"` : '') +
    '\n\nReturn only JSON with the keys "description" (string) and "genres" (array of up to 3 short strings).'
  )
}

function extractJson(content) {
  if (typeof content !== 'string') return null
  let text = content.trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

async function chatCompletions(base, body, { timeout }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return { status: res.status }
    const json = await res.json()
    return { content: json?.choices?.[0]?.message?.content ?? '' }
  } catch {
    return { error: 'request failed' }
  } finally {
    clearTimeout(timer)
  }
}

async function installedModels(base) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch(`${base}/v1/models`, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) return []
    const json = await res.json()
    return (json.data ?? []).map((m) => m.id).filter(Boolean)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

function pickModel(installed, preferred) {
  if (preferred && (!installed.length || installed.includes(preferred) || installed.some((m) => m.endsWith(`/${preferred}`)))) {
    return preferred
  }
  return installed[0] ?? preferred ?? DEFAULT_LLM_MODEL
}

export async function generateContent(book, meta, opts = {}) {
  const { host, model: preferred } = enrichDefaults()
  const base = opts.llmHost || opts.host || host
  const model = opts.model || preferred
  const timeout = opts.timeout ?? 120000

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildPrompt(meta, book) },
  ]
  const temperature = opts.temperature ?? 0.35

  async function attempt(withFormat, modelId) {
    const body = { model: modelId, messages, temperature, stream: false }
    if (withFormat) body.response_format = { type: 'json_object' }
    return chatCompletions(base, body, { timeout })
  }

  let resolved = model
  let out = await attempt(true, resolved)
  if (out.status === 400 || out.status === 422 || out.status === 404 || out.error) {
    const installed = await installedModels(base)
    resolved = pickModel(installed, preferred)
    out = await attempt(true, resolved)
    if (out.status === 400 || out.status === 422 || out.error) {
      out = await attempt(false, resolved)
    }
  } else if (out.status && !out.content) {
    return null
  }

  const parsed = extractJson(out.content)
  if (!parsed) return null
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
  return {
    description,
    genres: cleanGenres(parsed.genres),
    model: resolved,
  }
}

export async function llmStatus() {
  const { host, model } = enrichDefaults()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch(`${host}/v1/models`, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) return { ok: false, error: `LM Studio ${res.status}` }
    const json = await res.json()
    const installed = (json.data ?? []).map((m) => m.id).filter(Boolean)
    const resolved = pickModel(installed, model)
    return {
      ok: installed.length > 0,
      model: resolved,
      hasModel: installed.some((m) => m === resolved || m.endsWith(`/${resolved}`)),
      installed,
    }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'LM Studio timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function enrichBook(book, opts = {}) {
  if (!isValidIsbn(book?.isbn)) return null
  try {
    const meta = await fetchBookMeta(book.isbn, opts) ?? null
    if (!meta) return { provider: null, error: `no ISBN metadata found for ${book.isbn}` }

    let description = meta.description ?? ''
    let descriptionSource = description ? 'provider' : 'none'
    let descriptionModel = null
    let genres = cleanGenres(meta.categories)

    if (!description || genres.length === 0) {
      const generated = await generateContent(book, meta, opts)
      if (generated) {
        if (!description && generated.description) {
          description = generated.description
          descriptionSource = 'generated'
          descriptionModel = generated.model
        }
        if (genres.length === 0) genres = cleanGenres(generated.genres)
      } else if (!description && genres.length === 0) {
        return {
          provider: meta.provider,
          title: meta.title,
          authors: meta.authors,
          publisher: meta.publisher,
          year: meta.year,
          pageCount: meta.pageCount,
          categories: meta.categories,
          genres,
          coverThumb: meta.coverThumb,
          description,
          descriptionSource,
          descriptionModel,
          generatedAt: new Date().toISOString(),
          error: 'description generation failed (is LM Studio running with the model loaded?)',
        }
      }
    }

    return {
      provider: meta.provider,
      title: meta.title,
      authors: meta.authors,
      publisher: meta.publisher,
      year: meta.year,
      pageCount: meta.pageCount,
      categories: meta.categories,
      genres,
      coverThumb: meta.coverThumb,
      description,
      descriptionSource,
      descriptionModel,
      generatedAt: new Date().toISOString(),
    }
  } catch (e) {
    return { provider: null, error: e.message }
  }
}