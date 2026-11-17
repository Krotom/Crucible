// Optional: runs against a real robot log when CRUCIBLE_SAMPLE_LOG points at one. Skipped otherwise.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DataStore } from '../src/renderer/src/lib/store'
import { parseWpilog } from '../src/renderer/src/lib/wpilog'

const path = process.env.CRUCIBLE_SAMPLE_LOG
describe.skipIf(!path)('real log', () => {
  it('parses and decodes the robot topics', () => {
    const t0 = performance.now()
    const buf = new Uint8Array(fs.readFileSync(path!))
    const log = parseWpilog(buf)
    const store = new DataStore()
    store.loadLog(log, 'real')
    console.log(`parsed ${(buf.length / 1e6).toFixed(1)} MB, ${log.entries.length} entries in ${(performance.now() - t0).toFixed(0)} ms; t ${log.tMin.toFixed(1)}..${log.tMax.toFixed(1)} s; truncated=${log.truncated}`)
    const poseLike = store.topicNames().filter((n) => /Pose|Components/.test(n))
    console.log(poseLike.map((n) => `${n} [${store.series.get(n)!.type}] x${store.series.get(n)!.times.length}`).join('\n'))
    const mid = (log.tMin + log.tMax) / 2
    for (const n of ['/RealOutputs/Swerve/Pose', '/RealOutputs/Mechanism3d/Components', 'Swerve/Pose', 'Mechanism3d/Components']) {
      const v = store.valueAt(n, mid)
      if (v) console.log(n, Array.from(v as Float64Array).map((x) => x.toFixed(3)).join(' '))
    }
    expect(log.entries.length).toBeGreaterThan(0)
  })
})
