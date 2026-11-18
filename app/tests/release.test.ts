import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script without types
import { notesFor, parseChangelog } from '../scripts/release-notes.mjs'
import { CHANGELOG } from '../src/renderer/src/lib/versions'
import { pickAsset } from '../src/main/updater'
import { UPDATE_PUBLIC_KEY } from '../src/main/update-key'

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n') // a Windows checkout has CRLF line ends
const pkg = JSON.parse(read('../package.json')) as { version: string; scripts: Record<string, string> }
const yml = read('../../.github/workflows/release.yml')

describe('release notes', () => {
  it('the script reads the same CHANGELOG the app shows', () => {
    const parsed = parseChangelog(read('../src/renderer/src/lib/versions.ts'))
    expect(parsed).toEqual(CHANGELOG)
    expect(notesFor(parsed, CHANGELOG[0].version)).toContain(`## ${CHANGELOG[0].title}`); expect(notesFor(parsed, '0.0.0')).toBeNull()
  })
  it('the version in package.json has a CHANGELOG entry (a release without notes cannot go out)', () => {
    expect(CHANGELOG.some((r) => r.version === pkg.version), `add a CHANGELOG entry for ${pkg.version} to versions.ts`).toBe(true)
  })
  it('copes with brackets and quotes inside the entries', () => {
    const text = `export const CHANGELOG: Release[] = [\n  { version: '1.0.0', title: "It's [new]", items: ['a ] b', "c, 'd'"] },\n]\nconst x = [1]`
    expect(parseChangelog(text)).toEqual([{ version: '1.0.0', title: "It's [new]", items: ['a ] b', "c, 'd'"] }])
  })
})

describe('release workflow', () => {
  it('builds Windows, Linux and both kinds of Mac, and every script and file it names exists', () => {
    for (const os of ['windows-latest', 'ubuntu-latest', 'macos-latest', 'macos-15-intel']) expect(yml).toContain(`os: ${os}`)
    for (const m of yml.matchAll(/app\/(scripts\/[\w.-]+\.mjs)/g)) expect(() => read(`../${m[1]}`), m[1]).not.toThrow()
    for (const m of yml.matchAll(/node (scripts\/[\w.-]+\.mjs|e2e\/[\w.-]+\.mjs)/g)) expect(() => read(`../${m[1]}`), m[1]).not.toThrow()
    for (const m of yml.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts[m[1]], `npm run ${m[1]}`).toBeTruthy()
  })
  it('releases on a version change on main, on a v* tag, or by hand; a push that keeps the version does not touch an existing release', () => {
    expect(yml).toMatch(/branches: \[main\]\n\s+paths: \['app\/package\.json'\]/); expect(yml).toMatch(/tags: \['v\*'\]/); expect(yml).toMatch(/workflow_dispatch/)
    expect(yml).toMatch(/skip=true/); expect(yml).toMatch(/if: needs\.plan\.outputs\.skip != 'true'/); expect(yml).toMatch(/does not match the version in app\/package\.json/)
  })
  it('gates the build on the checks, publishes only from the last job, and gives only that job write access', () => {
    expect(yml).toMatch(/build:[\s\S]*needs: \[plan, checks, icons\]/); expect(yml).toMatch(/publish:[\s\S]*needs: \[plan, build\]/)
    expect((yml.match(/contents: write/g) ?? []).length).toBe(1); expect(yml.indexOf('contents: write')).toBeGreaterThan(yml.indexOf('publish:')); expect(yml).toMatch(/permissions:\n {2}contents: read/)
  })
  it('lists checksums for every file, signs when a key is set, refuses to publish unsigned when the app carries a key, and updates files of an existing release', () => {
    expect(yml).toMatch(/sha256sum -- \* > SHA256SUMS\.txt/); expect(yml).toMatch(/sign-release\.mjs dist\/SHA256SUMS\.txt/); expect(yml).toMatch(/BEGIN PUBLIC KEY/); expect(yml).toMatch(/gh release upload "\$TAG" dist\/\* --clobber/); expect(yml).toMatch(/gh release create/)
  })
  it('gets NSIS for the Windows installer in a way that survives a flaky package feed: cached, retried, and checked before packaging', () => {
    expect(yml).toMatch(/uses: actions\/cache@v4[\s\S]*path: C:\\Program Files \(x86\)\\NSIS/)
    const step = yml.slice(yml.indexOf('name: NSIS (Windows installer)'), yml.indexOf('npm run package'))
    expect(step).toMatch(/for i in 1 2 3 4/); expect(step).toMatch(/choco install nsis[^\n]*\|\| true/); expect(step).toMatch(/\[ ! -f "\$nsis" \]/); expect(step).toMatch(/::error::makensis\.exe was not installed/); expect(step).toMatch(/MAKENSIS=/)
    expect(yml.indexOf('name: NSIS (Windows installer)')).toBeLessThan(yml.indexOf('npm run package'))
    expect(read('../scripts/build-installer.mjs')).toMatch(/process\.env\.MAKENSIS/)
  })
  it('smoke-tests the packaged Linux app and its self-update before publishing', () => {
    expect(yml).toMatch(/scripts\/smoke-packaged\.mjs/); expect(yml).toMatch(/e2e\/update-packaged\.mjs/)
  })
  it('names the files the way the updater looks for them', () => {
    const v = pkg.version
    const names = [`BALTA-Crucible-Setup-${v}.exe`, `BALTA-Crucible-${v}-linux-x64.tar.gz`, `BALTA-Crucible-${v}-mac-arm64.zip`, `BALTA-Crucible-${v}-mac-x64.zip`].map((name) => ({ name, url: `https://x.test/${name}`, size: 1 }))
    expect(pickAsset(names, 'win32', 'x64', v)).not.toBeNull(); expect(pickAsset(names, 'linux', 'x64', v)).not.toBeNull(); expect(pickAsset(names, 'darwin', 'arm64', v)).not.toBeNull(); expect(pickAsset(names, 'darwin', 'x64', v)).not.toBeNull()
    const pk = read('../scripts/package.mjs'), nsis = read('../scripts/build-installer.mjs')
    expect(pk).toContain('BALTA-Crucible-${version}-linux-${arch}'); expect(pk).toContain('${folder}.tar.gz'); expect(pk).toContain('BALTA-Crucible-${version}-mac-${arch}.zip'); expect(nsis).toContain('BALTA-Crucible-Setup-${version}.exe')
  })
  it('the signing key is either unset or a public key (the private key is never committed)', () => {
    expect((UPDATE_PUBLIC_KEY as string) === '' || (UPDATE_PUBLIC_KEY as string).startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true)
    expect(read('../src/main/update-key.ts')).not.toMatch(/PRIVATE KEY/); expect(read('../../.gitignore')).toMatch(/update-private-key\.pem/)
  })
})
