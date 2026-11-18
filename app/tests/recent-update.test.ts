import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RecentFiles } from '../src/main/recent'
import { checkForUpdate } from '../src/main/update'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crucible-recent-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const touch = (n: string, body = 'x'): string => { const p = join(dir, n); writeFileSync(p, body); return p }

describe('recent files', () => {
  it('lists the newest first, moves a reopened file to the top, and holds each once', async () => {
    const r = new RecentFiles(dir), a = touch('a.wpilog'), b = touch('b.json'), c = touch('c.csv')
    await r.add(a); await r.add(b); await r.add(c); await r.add(a)
    expect((await r.list()).map((f) => f.name)).toEqual(['a.wpilog', 'c.csv', 'b.json'])
  })
  it('drops files that no longer exist, caps the list at 8, and refuses other kinds of file', async () => {
    const r = new RecentFiles(dir)
    for (let i = 0; i < 12; i++) await r.add(touch(`f${i}.wpilog`))
    expect(await r.list()).toHaveLength(8); expect((await r.list())[0].name).toBe('f11.wpilog')
    rmSync(join(dir, 'f11.wpilog')); expect((await r.list())[0].name).toBe('f10.wpilog')
    expect(await r.add(touch('notes.txt'))).toBe(false); expect(await r.add(touch('run.exe'))).toBe(false); expect(await r.add('')).toBe(false)
  })
  it('reads only files that are in the list (the page cannot read arbitrary paths) and forgets on request', async () => {
    const r = new RecentFiles(dir), a = touch('a.wpilog', 'hello'), secret = touch('secret.json', 'nope')
    await r.add(a)
    expect((await r.read(a))?.data.toString()).toBe('hello'); expect(await r.read(secret)).toBeNull(); expect(await r.read('/etc/passwd')).toBeNull()
    await r.forget(a); expect(await r.list()).toEqual([]); expect(await r.read(a)).toBeNull()
  })
  it('starts empty and survives a damaged list file', async () => {
    expect(await new RecentFiles(dir).list()).toEqual([]); writeFileSync(join(dir, 'recent-files.json'), '{broken'); expect(await new RecentFiles(dir).list()).toEqual([])
  })
})

describe('update check', () => {
  const answer = (status: number, body: unknown): typeof fetch => (async () => ({ status, json: async () => body })) as unknown as typeof fetch
  it('reports a newer release, the current one, and a project with no release', async () => {
    expect((await checkForUpdate('1.1.0', answer(200, { tag_name: 'v1.2.0', html_url: 'https://github.com/x/y/releases/tag/v1.2.0' }))).status).toBe('newer')
    expect((await checkForUpdate('1.1.0', answer(200, { tag_name: 'v1.1.0' }))).status).toBe('current'); expect((await checkForUpdate('1.1.0', answer(404, { message: 'Not Found' }))).status).toBe('none')
  })
  it('reports errors in words: no network, a timeout, a bad answer', async () => {
    const down = (async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') }) as unknown as typeof fetch
    expect(await checkForUpdate('1.1.0', down)).toMatchObject({ status: 'error', error: expect.stringContaining('Could not reach') })
    const abort = (async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }) as unknown as typeof fetch
    expect((await checkForUpdate('1.1.0', abort)).error).toMatch(/in time/)
    const junk = (async () => ({ status: 200, json: async () => { throw new Error('bad json') } })) as unknown as typeof fetch
    expect((await checkForUpdate('1.1.0', junk)).status).toBe('error')
  })
  it('sends no information about the user (only a fixed client name)', async () => {
    let seen: { url?: string; init?: RequestInit } = {}
    await checkForUpdate('1.1.0', (async (url: string, init: RequestInit) => { seen = { url, init }; return { status: 404, json: async () => ({}) } }) as unknown as typeof fetch)
    expect(seen.url).toMatch(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/); const values = Object.values(seen.init?.headers as Record<string, string>); expect(values).toContain('balta-crucible'); expect(values.join(' ')).not.toMatch(/@|\/home|\/Users/i)
  })
})
