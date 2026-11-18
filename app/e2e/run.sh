#!/usr/bin/env bash
# UI tests against the real Electron app, under a virtual display. Usage: e2e/run.sh [suite ...]   (default: all)
# Suites: ui-launcher ui-sim ui-layout ui-batch1 ... and robot-ui (robot code against a fake robot on ports 5810/5811).
# Needs: Electron's binary (node node_modules/electron/install.js), xvfb-run, Playwright (npm i -g playwright), python3 with Pillow for ui-layout.
set -uo pipefail
cd "$(dirname "$0")/.."
export SP="${E2E_DIR:-/tmp/crucible-e2e}"
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
[ -x node_modules/electron/dist/electron ] || { echo "Electron binary missing: run  node node_modules/electron/install.js  first" >&2; exit 1; }
mkdir -p "$SP/e2e/out"
rm -rf "$SP/fakerobot"; cp -r e2e/fakerobot "$SP/fakerobot"; chmod +x "$SP/fakerobot/gradlew"; echo normal > "$SP/fakerobot/mode.txt"
# E2E_NO_BUILD=1: use the build that is there (suites run side by side must not rebuild underneath each other)
[ -n "${E2E_NO_BUILD:-}" ] || npm run build >/dev/null || exit 1
suites=("$@"); if [ ${#suites[@]} -eq 0 ]; then suites=($(ls e2e/ui-*.js | xargs -n1 basename | sed 's/\.js$//') robot-ui); fi
fail=0
for s in "${suites[@]}"; do
  echo "== $s"
  if [ "$s" = "robot-ui" ]; then
    xvfb-run -a -s "-screen 0 1700x1000x24" npx vitest run --config vitest.e2e.config.ts >"$SP/e2e/robot-run.log" 2>&1 || fail=1
    [ -n "${E2E_VERBOSE:-}" ] && tail -n 60 "$SP/e2e/robot-run.log"
    python3 - <<PY || fail=1
import json,sys
r=json.load(open("$SP/e2e/robot-results.json")); c={}
for x in r: c[x['status']]=c.get(x['status'],0)+1; print(x['status'],x['name'],x['note']) if x['status']!='PASS' else None
print('SUMMARY',c); sys.exit(1 if c.get('FAIL') else 0)
PY
  else
    # E2E_VERBOSE=1 (CI) shows every check as it finishes, so a hang shows where it stopped; otherwise only notes, failures and the summary
    timeout "${E2E_SUITE_TIMEOUT:-900}" xvfb-run -a -s "-screen 0 1700x1000x24" node "e2e/$s.js" | { if [ -n "${E2E_VERBOSE:-}" ]; then cat; else grep -E "^(NOTE|FAIL)|SUMMARY" || true; fi; }
    code="${PIPESTATUS[0]}"
    [ "$code" = "0" ] || fail=1
    [ "$code" = "124" ] && echo "FAIL $s: stopped after ${E2E_SUITE_TIMEOUT:-900} s (a check is hung; the last line above is the last one that finished)"
  fi
done
exit $fail
