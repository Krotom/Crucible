# Ideas checklist

Status of the feature ideas list (see the conversation history of the session that built it). `[x]` done and tested, `[~]` partly, `[ ]` not yet.
UI tests: `npm run e2e` (needs Electron, xvfb, Playwright; see `app/e2e/run.sh`). Unit tests: `npm test`.

## Robot launcher and log
- [x] Build and run status line (parsed from Gradle output, elapsed time, bar)
- [x] Also start the sim when launching
- [x] Jump to first error, next / previous
- [x] Log level toggles
- [x] Relaunch button
- [x] Multiple log tabs (build vs robot prints)
- [x] Click-through stack traces
- [x] Persistent log and history
- [x] Robot project picker in-app
- [x] Pre-flight checks
- [x] Environment variables box

## Stats panel and 3D view
- [x] Pin / drag the panel
- [x] Event feed
- [x] Scoreboard view
- [x] Camera presets
- [x] Trails and landing spots (3D) and shot map (Analysis)
- [x] Shot arcs
- [x] Collision box / intake volume / scoring volume toggles (beam breaks are in the panel)
- [x] Robot cam picture-in-picture
- [x] Measurement tool and distance to HUB

## Match and scoring
- [x] Match timeline
- [x] Score breakdown
- [x] Match summary report
- [x] Choose start position and alliance
- [x] Rules overlay (zones, center line)
- [x] Foul explanations
- [x] Practice-match mode (blue ally, red cycler, both)

## Replay and analysis
- [x] Record the sim to a .wpilog (Save .wpilog… in the Analysis tab)
- [x] Rewind and replay (last minute, scripted robot)
- [x] Branch from here (three state slots)
- [x] A/B comparison of runs
- [x] Cycle-time histogram
- [x] Statistics across seeds (scripted robot)
- [x] Export plot as CSV / PNG
- [x] Compare sim with real logs (reference log overlay)

## Calibration and tuning
- [x] In-app calibration wizard (Tune tab)
- [x] Live parameter sliders (Tune tab)
- [x] Parameter presets (floor friction)
- [x] Guess badges (from robot.yaml tags)
- [ ] Sensitivity report

## Robot testing
- [ ] Built-in test scenarios
- [ ] Fault injection
- [ ] Battery model
- [ ] Mechanism inspector graphs
- [ ] Breakpoints on events
- [ ] Gamepad remapping and controller test
- [ ] Vision simulation

## Quality of life
- [x] Keyboard shortcut sheet and shortcuts
- [x] Remember last settings
- [ ] Session presets
- [ ] Command palette
- [ ] Stacking notifications
- [ ] Recent files
- [ ] Update check and what's new
- [ ] Turkish UI
- [ ] Accessibility (colour-blind-safe colours, large text)

## Team and sharing
- [ ] Share a run (replayable file)
- [ ] Attempts scoreboard
- [ ] Strategy board
- [ ] Screenshots and videos with overlays
- [ ] Report embedded in the repo (HTML)

## Developer and CI
- [ ] Headless mode in CI
- [ ] Plugin / game-module loader
- [x] UI test suites in the repo (`app/e2e`)
- [ ] Local API
