// A small bounded Nelder-Mead minimizer: enough for fitting two or three model parameters to measured data, deterministic, no dependencies.
export interface FitResult { x: number[]; value: number; evaluations: number; converged: boolean }

export interface Bounds { min: number; max: number }

export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  bounds: Bounds[],
  opts: { maxEvaluations?: number; tolerance?: number; step?: number } = {},
): FitResult {
  const n = x0.length
  const maxEval = opts.maxEvaluations ?? 200
  const tol = opts.tolerance ?? 1e-6
  const step = opts.step ?? 0.15
  const clampX = (x: number[]): number[] => x.map((v, i) => Math.min(bounds[i].max, Math.max(bounds[i].min, v)))
  let evals = 0
  const ev = (x: number[]): number => { evals++; return f(x) }

  // initial simplex: x0 and one point per axis, stepped by a fraction of the range (reflected inside the bounds)
  let simplex: { x: number[]; v: number }[] = [{ x: clampX(x0), v: 0 }]
  for (let i = 0; i < n; i++) {
    const p = [...simplex[0].x]
    const range = bounds[i].max - bounds[i].min
    p[i] += p[i] + step * range > bounds[i].max ? -step * range : step * range
    simplex.push({ x: clampX(p), v: 0 })
  }
  simplex.forEach((s) => { s.v = ev(s.x) })

  let converged = false
  while (evals < maxEval) {
    simplex.sort((a, b) => a.v - b.v)
    const best = simplex[0]
    const worst = simplex[n]
    const spread = Math.abs(worst.v - best.v)
    const size = Math.max(...simplex.slice(1).map((s) => Math.max(...s.x.map((v, i) => Math.abs(v - best.x[i]) / Math.max(1e-12, bounds[i].max - bounds[i].min)))))
    if (spread < tol * (1 + Math.abs(best.v)) && size < 1e-3) { converged = true; break }
    const centroid = best.x.map((_, i) => simplex.slice(0, n).reduce((s, p) => s + p.x[i], 0) / n)
    const along = (t: number): number[] => clampX(centroid.map((c, i) => c + t * (worst.x[i] - c)))
    const refl = along(-1)
    const rv = ev(refl)
    if (rv < best.v) {
      const exp = along(-2)
      const evv = ev(exp)
      simplex[n] = evv < rv ? { x: exp, v: evv } : { x: refl, v: rv }
    } else if (rv < simplex[n - 1].v) {
      simplex[n] = { x: refl, v: rv }
    } else {
      const con = rv < worst.v ? along(-0.5) : along(0.5)
      const cv = ev(con)
      if (cv < Math.min(rv, worst.v)) simplex[n] = { x: con, v: cv }
      else for (let k = 1; k <= n; k++) { const x = clampX(simplex[k].x.map((v, i) => best.x[i] + 0.5 * (v - best.x[i]))); simplex[k] = { x, v: ev(x) } }
    }
  }
  simplex.sort((a, b) => a.v - b.v)
  return { x: simplex[0].x, value: simplex[0].v, evaluations: evals, converged }
}

export function rms(residuals: number[]): number {
  return residuals.length ? Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length) : 0
}
