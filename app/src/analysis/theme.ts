// The look of generated reports: BALTA brand colors (gold #cb8e00, silver #dcdcdc, black #010101), light and dark by the reader's system setting,
// and the header and footer every report page carries. The emblem and wordmark are inline images, so a report file stands alone.
import { EMBLEM_DARK_B64, EMBLEM_LIGHT_B64, WORDMARK_INK_B64, WORDMARK_LIGHT_B64 } from '../branding/assets'

export const REPORT_STYLE = `:root{--bg:#f3f2ef;--card:#fff;--fg:#15171a;--muted:#636a73;--grid:#e6e3dd;--line:#d9d5cd;--blue:#1a73e8;--red:#c93a2e;--accent:#a87400;--ok:#1a8f4d;--field:#f7f6f3}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0b0c0e;--card:#121417;--fg:#dcdcdc;--muted:#8d939b;--grid:#23272d;--line:#23272d;--blue:#6ea8fe;--red:#ff8a80;--accent:#cb8e00;--ok:#5bd490;--field:#14171b}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;margin:0;padding:0 16px 32px}main{max-width:880px;margin:0 auto}
.brandbar{display:flex;align-items:center;gap:12px;padding:16px 0 14px;margin-bottom:18px;border-bottom:1px solid var(--line);position:relative}
.brandbar::after{content:'';position:absolute;left:0;bottom:-1px;width:34%;height:2px;background:linear-gradient(90deg,var(--accent),transparent)}
.brandbar img.e{height:34px}.brandbar img.w{height:16px}
.brandbar .p{font-size:11px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:var(--accent);padding-left:12px;border-left:1px solid var(--line)}
.brandbar .k{margin-left:auto;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.t-dark{display:none}@media (prefers-color-scheme: dark){.t-dark{display:inline}.t-light{display:none}}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}p.sub{color:var(--muted);margin:0 0 16px}
pre{background:var(--card);border:1px solid var(--line);padding:12px;border-radius:8px;overflow-x:auto;font-size:13px}
figure{margin:12px 0}figcaption{color:var(--muted);font-size:13px}svg{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--muted);font-size:11px}.field{fill:var(--field)}.path{stroke:var(--accent);stroke-width:2;fill:none}.hit{fill:var(--ok);stroke:var(--ok)}.miss{fill:none;stroke:var(--red);stroke-width:2}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}
footer{margin-top:28px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;display:flex;justify-content:space-between}`

const img = (b64: string, cls: string, theme: string): string => `<img class="${cls} ${theme}" alt="" src="data:image/png;base64,${b64}">`

/** The header of a report page; `kind` is the small label at the right ("Run report", "Report"). */
export function brandHeader(kind: string): string {
  return `<div class="brandbar">${img(EMBLEM_LIGHT_B64, 'e', 't-light')}${img(EMBLEM_DARK_B64, 'e', 't-dark')}${img(WORDMARK_INK_B64, 'w', 't-light')}${img(WORDMARK_LIGHT_B64, 'w', 't-dark')}<span class="p">Crucible</span><span class="k">${kind}</span></div>`
}

export const brandFooter = (): string => '<footer><span>BALTA Crucible</span><span>BALTA Robotics</span></footer>'
