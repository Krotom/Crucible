# Testing

Three layers: unit tests (fast, no window), UI tests (the real Electron app driven through its window) and checks in CI. Everything below is run from `app/`.

## Unit tests

`npm test` (vitest, about a minute; the engine tests simulate seconds of physics, hence the 30 s timeout in `vitest.config.ts`). `npm run typecheck` is part of the same bar. About 360 tests in `app/tests/`:

- **Engine and physics:** ballistics against analytic cases, drag, bounce, mechanism step response against closed-form motor solutions, swerve cases, contact, BUMPS, the REBUILT rules, determinism (same seed and inputs give the same state hash; snapshots replay the identical future), a golden hash.
- **Bridge and robot:** the frame codec, the WebSocket transport against a fake robot, NetworkTables against a fake server, lockstep (including a repeatability test), the robot definition against the real robot code's registrations (`real-robot.test.ts`; it and `real-log.test.ts` skip themselves when the robot project or a sample log is not there), the integration tool.
- **Analysis and tools:** the match recorder, report and CSV, comparison, WPILOG writer, seed sweep, tuning, calibration (fits recover known parameters from synthetic data), sensitivity, breakpoints, faults, scenarios, vision geometry, attempts, run files, strategy board, command palette, presets, Turkish dictionary (every key must still exist in `index.html`, so a renamed label cannot silently lose its translation), colour-blind palette contrast, update logic (version comparison, asset choice, checksums, signatures, downloads against a local server, the swap script run for real in temporary folders), the local API (token, Origin and Host checks, size and time limits), recent files, project reports (a name cannot climb out of the folder), game-plugin validation, the example plugin, release notes, and the workflows (every script and file they name exists, permissions, job order).
- **Helpers:** `tests/helpers/` has the fake robot (WebSocket) and fake NetworkTables server used by several tests.

A few tests need things outside the repo (the OffSeasonCode robot project; `CRUCIBLE_SAMPLE_LOG`; `CRUCIBLE_BENCH=1` for the benchmark) and skip otherwise.

## UI tests

`npm run e2e` (`bash e2e/run.sh [suite …]`, all suites by default) builds the app and drives the **built** Electron app with Playwright under a virtual display. Each launch gets its own settings folder, so nothing leaks between suites. A failed check writes a screenshot to `$E2E_DIR/e2e/fail-<name>.png` (default `/tmp/crucible-e2e`), and the suites print `PASS` / `NOTE` / `FAIL` lines and a summary (a `NOTE` is a finding that works but not as one might expect, with the reason).

Needs: Electron's binary (`node node_modules/electron/install.js`), `xvfb-run`, Playwright reachable through `NODE_PATH` (`npm i -g playwright`, `run.sh` defaults `NODE_PATH` to the global modules), Python 3 with Pillow and ImageMagick's `import` for `ui-layout`. Do not build while suites run: `run.sh` builds first, and a build underneath a running suite breaks it.

| Suite | Covers |
|---|---|
| `ui-batch1` | the run status line (Not running, Starting, Building with the bar, elapsed timer, Stopped / Failed / Exited, Relaunch), "also start the sim", error counts and jumping between errors |
| `ui-launcher`, `ui-launcher2` | launching a fake robot project (a fake `gradlew` in `e2e/fakerobot`): window and tabs, streamed output and colours, stopping the process tree, exit codes, the last partial line, ANSI codes, long lines; the project row and recent projects, Check project, extra environment, log tabs, source links, a broken editor, past runs, no Java |
| `ui-sim` | the scripted sim: play, speed, step, reset, save and load state, the panel, topics, opening logs (good, truncated, garbage, empty), plot export |
| `ui-layout` | window sizes, sidebar and tab fit, pixel checks |
| `ui-analysis` | the Analysis tab: empty states, the timeline and its markers, the match-end summary, the summary table, the event feed filters, the shot map and histogram, the HTML report, Reset and Load state, large event counts |
| `ui-view` | cameras, ruler, View menu overlays, robot camera, scoreboard, alliance and start position, practice opponents |
| `ui-replay` | rewind, slots, CSV / PNG / WPILOG / run exports, compare, sweep, reference log |
| `ui-tune` | sliders and presets, persistence, messages to the sim, guess badges, calibration, sensitivity |
| `ui-testing` | breakpoints (time, phase, junk input), the robot testing card, the mechanism inspector, the Controls dialog (gamepad display, Learn, dead zone, standard layout) and key rebinding |
| `ui-quality` | toasts, command palette, presets, preferences (Turkish, colour-blind colours, large text), recent files, update check and what's new |
| `ui-team` | attempts, shared runs, project reports, strategy board, screenshots and video with the banner, game plugins, local API |
| `robot-ui` (vitest, `e2e/robot-ui.e2e.test.ts`) | the real app against a fake robot on the real ports (5811 bridge, 5810 NT): connection, DS and gamepad frames, keyboard driving, lockstep, rewind refusal, scenarios, vision messages, breakpoints with a live robot |
| `update-packaged.mjs` | not part of `run.sh`: the self-update of a packaged Linux app against a local release server (see [RELEASING.md](RELEASING.md)); the release workflow runs it |

Things learned while writing them: native dialogs cannot be driven, so the tests stub `dialog.showSaveDialog` in the main process and check the written file; the match-summary popup is modal and blocks clicks (tests untick it for long runs); a new sim waits for Play; a control on another tab is not clickable.

## CI

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, unit tests and build, then (after those pass) the UI suites under `xvfb` on an Ubuntu runner with Playwright 1.63. `.github/workflows/release.yml` re-runs typecheck and unit tests before building release packages ([RELEASING.md](RELEASING.md)). A unit test (`tests/batch9.test.ts`, `tests/release.test.ts`) keeps both workflows consistent with the repository: only npm scripts that exist, the scripts and files they name exist, the Electron binary is fetched before the UI tests, the release job order and permissions.

The UI job takes ten minutes or more; limit it to `main` in the `on:` block of `ci.yml` if that is too slow for every push.

## Not covered

No test of the real Windows or macOS packages, or of their self-update; no test against a real robot or real shot data; the native file dialogs and the OS-level installer UI are not driven. See *Known limits* in [app/README.md](../app/README.md).
