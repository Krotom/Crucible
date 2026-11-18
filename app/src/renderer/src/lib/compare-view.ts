// The compare card: two runs side by side (table with who did better) and their score and path charts.
import type { RunReport } from '../../../analysis/recorder'
import { compareReports, pathChartSvg, scoreChartSvg } from './compare'

function cell(text: string, cls?: string): HTMLElement {
  const td = document.createElement('td')
  td.textContent = text
  if (cls) td.className = cls
  return td
}

export function renderCompare(into: HTMLElement, a: RunReport | null, b: RunReport | null, field?: { length: number; width: number }): void {
  into.textContent = ''
  const names = document.createElement('div')
  names.className = 'cmp-names'
  const na = document.createElement('span'); na.className = 'cmp-a'; na.textContent = `A: ${a ? a.name : 'not loaded'}`
  const nb = document.createElement('span'); nb.className = 'cmp-b'; nb.textContent = `B: ${b ? b.name : 'not loaded'}`
  names.append(na, nb)
  into.appendChild(names)
  if (!a || !b) { const h = document.createElement('div'); h.className = 'dimtext'; h.textContent = 'Load or choose both runs to compare them.'; into.appendChild(h); return }

  const table = document.createElement('table')
  table.className = 'an-table cmp-table'
  const head = document.createElement('tr')
  for (const t of ['', 'A', 'B', 'B − A']) { const th = document.createElement('th'); th.textContent = t; head.appendChild(th) }
  table.appendChild(head)
  for (const r of compareReports(a, b)) {
    const tr = document.createElement('tr')
    const label = cell(r.label)
    tr.append(label, cell(r.a, r.better === 'a' ? 'win' : ''), cell(r.b, r.better === 'b' ? 'win' : ''), cell(r.delta, `delta ${r.better === 'none' || r.better === 'same' ? '' : r.better === 'b' ? 'good' : 'bad'}`))
    table.appendChild(tr)
  }
  into.appendChild(table)
  const charts = document.createElement('div')
  charts.className = 'cmp-charts'
  // the charts are built from numbers and escaped names only (see compare.ts)
  charts.innerHTML = scoreChartSvg(a, b) + pathChartSvg(a, b, field?.length, field?.width)
  into.appendChild(charts)
}
