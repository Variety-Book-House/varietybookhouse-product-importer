import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { startServer } from '../src/web.mjs'

const SHA = 'c'.repeat(64)
const EXIF_SHA = 'f'.repeat(64)

describe('web.mjs /api/image/:sha/crop', () => {
  let server
  let base
  let jobDir

  beforeAll(async () => {
    jobDir = await mkdtemp(path.join(tmpdir(), 'bsi-crop-test-'))
    await mkdir(path.join(jobDir, 'originals'), { recursive: true })
    await mkdir(path.join(jobDir, 'crops'), { recursive: true })
    const orig = await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer()
    await writeFile(path.join(jobDir, 'originals', `${SHA}.jpg`), orig)
    // raw 300x100 with EXIF orientation 6 => browser-visible 100x300
    const exifOrig = await sharp({ create: { width: 300, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
    await writeFile(path.join(jobDir, 'originals', `${EXIF_SHA}.jpg`), exifOrig)
    const auto = await sharp({ create: { width: 50, height: 60, channels: 3, background: { r: 0, g: 255, b: 0 } } })
      .jpeg()
      .toBuffer()
    await writeFile(path.join(jobDir, 'crops', `${SHA}.jpg`), auto)
    const state = {
      folder: '/tmp/fake',
      dryRun: false,
      updatedAt: null,
      images: {
        [SHA]: { sha: SHA, file: 'x.jpg', path: '/tmp/fake/x.jpg', status: 'ocr_done', dims: { width: 50, height: 60 }, manualCrop: null },
        [EXIF_SHA]: { sha: EXIF_SHA, file: 'y.jpg', path: '/tmp/fake/y.jpg', status: 'ocr_done', dims: null, manualCrop: null },
      },
      books: {},
    }
    await writeFile(path.join(jobDir, 'state.json'), JSON.stringify(state, null, 2))
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

  async function postCrop(body) {
    const res = await fetch(`${base}/api/image/${SHA}/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }

  it('crops the original into the crop file and records fractions + dims', async () => {
    const { status, data } = await postCrop({ x0: 0.25, y0: 1 / 3, x1: 0.75, y1: 2 / 3 })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    const info = await sharp(path.join(jobDir, 'crops', `${SHA}.jpg`)).metadata()
    expect({ width: info.width, height: info.height }).toEqual({ width: 100, height: 100 })
    expect(data.manualCrop).toEqual({ x0: 0.25, y0: 1 / 3, x1: 0.75, y1: 2 / 3 })
    const state = JSON.parse(await readFile(path.join(jobDir, 'state.json'), 'utf8'))
    expect(state.images[SHA].manualCrop).toEqual(data.manualCrop)
    expect(state.images[SHA].dims).toEqual({ width: 100, height: 100 })
  })

  it('backs up the auto crop on first manual crop', async () => {
    const auto = await readFile(path.join(jobDir, 'crops', `${SHA}.auto.jpg`))
    const green = await sharp(auto).stats()
    expect(green.channels[1].mean).toBeCloseTo(255, 0)
  })

  it('rejects tiny and malformed rects, unknown sha 404s', async () => {
    expect((await postCrop({ x0: 0, y0: 0, x1: 0.01, y1: 0.01 })).status).toBe(400)
    expect((await postCrop({ x0: 0.1, y0: 'abc', x1: 0.5, y1: 0.5 })).status).toBe(400)
    const res = await fetch(`${base}/api/image/${'e'.repeat(64)}/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }),
    })
    expect(res.status).toBe(404)
  })

  it('reset restores the auto crop bytes and clears manualCrop', async () => {
    const { status, data } = await postCrop({ reset: true })
    expect(status).toBe(200)
    expect(data).toMatchObject({ ok: true, manualCrop: null, restored: true })
    const crop = await readFile(path.join(jobDir, 'crops', `${SHA}.jpg`))
    const auto = await readFile(path.join(jobDir, 'crops', `${SHA}.auto.jpg`))
    expect(crop.equals(auto)).toBe(true)
    const state = JSON.parse(await readFile(path.join(jobDir, 'state.json'), 'utf8'))
    expect(state.images[SHA].manualCrop).toBe(null)
    expect(state.images[SHA].dims).toEqual({ width: 50, height: 60 })
    expect((await postCrop({ reset: true })).status).toBe(400)
  })

  it('maps crop fractions to the EXIF-upright (browser-visible) pixels', async () => {
    const res = await fetch(`${base}/api/image/${EXIF_SHA}/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x0: 0, y0: 0, x1: 0.5, y1: 1 }),
    })
    expect(res.status).toBe(200)
    const info = await sharp(path.join(jobDir, 'crops', `${EXIF_SHA}.jpg`)).metadata()
    expect({ width: info.width, height: info.height }).toEqual({ width: 50, height: 300 })
  })
})
