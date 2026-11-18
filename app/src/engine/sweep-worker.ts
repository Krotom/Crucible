// Worker entry for the seed sweep: one request in, a progress message per run, then the end.
import { runSweep, type SweepRequest, type SweepRun } from './sweep'

export type SweepIn = { type: 'start'; req: SweepRequest } | { type: 'cancel' }
export type SweepOut = { type: 'run'; run: SweepRun; index: number; total: number } | { type: 'done'; cancelled: boolean } | { type: 'error'; message: string }

let cancelled = false
const post = (m: SweepOut): void => (self as unknown as Worker).postMessage(m)

self.onmessage = (ev: MessageEvent<SweepIn>) => {
  const m = ev.data
  if (m.type === 'cancel') { cancelled = true; return }
  cancelled = false
  runSweep(m.req, (run, index) => post({ type: 'run', run, index, total: m.req.seeds.length }), () => cancelled)
    .then(() => post({ type: 'done', cancelled }))
    .catch((e: Error) => post({ type: 'error', message: e.message }))
}
