#!/usr/bin/env bash
# UI tests against the real Electron app, under a virtual display. Usage: e2e/run.sh [suite ...]   (default: all)
# Suites: ui-launcher ui-sim ui-layout ui-batch1 ... and robot-ui (robot code against a fake robot on ports 5810/5811).
# Needs: Electron's binary (node node_modules/electron/install.js), xvfb-run, Playwright (npm i -g playwright), python3 with Pillow for ui-layout.
set -uo pipefail
cd "$(dirname "$0")/.."
export SP="${E2E_DIR:-/tmp/crucible-e2e}"
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
mkdir -p "$SP/e2e/out"
rm -rf "$SP/fakerobot"; cp -r e2e/fakerobot "$SP/fakerobot"; chmod +x "$SP/fakerobot/gradlew"; echo normal > "$SP/fakerobot/mode.txt"
npm run build >/dev/null || exit 1
suites=("$@"); if [ ${#suites[@]} -eq 0 ]; then suites=($(ls e2e/ui-*.js | xargs -n1 basename | sed 's/\.js$//') robot-ui); fi
fail=0
for s in "${suites[@]}"; do
  echo "== $s"
  if [ "$s" = "robot-ui" ]; then
    xvfb-run -a -s "-screen 0 1700x1000x24" npx vitest run --config vitest.e2e.config.ts >"$SP/e2e/robot-run.log" 2>&1 || fail=1
    python3 - <<PY || fail=1
import json,sys
r=json.load(open("$SP/e2e/robot-results.json")); c={}
for x in r: c[x['status']]=c.get(x['status'],0)+1; print(x['status'],x['name'],x['note']) if x['status']!='PASS' else None
print('SUMMARY',c); sys.exit(1 if c.get('FAIL') else 0)
PY
  else
    xvfb-run -a -s "-screen 0 1700x1000x24" node "e2e/$s.js" | grep -E "^(NOTE|FAIL)|SUMMARY" || true
    [ "${PIPESTATUS[0]}" = "0" ] || fail=1
  fi
done
exit $fail
