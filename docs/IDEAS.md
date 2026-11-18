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
- [x] Built-in test scenarios (Robot tab: drive forward, strafe, spin, climb the BUMP)
- [x] Fault injection (Robot tab: brownout, latency, noise, dropped CAN ids)
- [x] Battery model (Robot tab, live in the panel)
- [x] Mechanism inspector graphs (volts, speed, position, current; no thermal model)
- [x] Breakpoints on events (Analysis tab)
- [x] Gamepad remapping and controller test (Controls dialog, G)
- [x] Vision simulation (app side: assumed tag layout, camera cone and rays in 3D, noisy pose estimate sent as bridge message 9; the robot-side consumer in robot-lib is not written, so only a fake robot has received it)

## Quality of life
- [x] Keyboard shortcut sheet and shortcuts
- [x] Remember last settings
- [x] Session presets (Session tab: save, load, delete named set-ups; also from the palette)
- [x] Command palette (Ctrl+K: every shortcut action plus presets, language, colours; ignores accents)
- [x] Stacking notifications (toasts: at most four, repeats counted, errors stay longer; the status line still shows the latest)
- [x] Recent files (opened logs, eight newest, in the Data card; a deleted file is reported and dropped)
- [x] Update check and what's new (About: asks GitHub for the latest release of this repo; an updated app shows a toast, never a dialog; no release exists yet, so the answer today is "none published")
- [x] Turkish UI (partial: the fixed labels, about 190 strings; messages built at run time, panel rows and log lines stay English)
- [x] Accessibility (colour-blind-safe colours in the interface and the 3D zones; large text is a 1.2x window zoom; robot and bumper colours in 3D are unchanged)

## Team and sharing
- [x] Share a run (Analysis tab: one file with the set-up and the result; opening it restores the settings and loads the result as run A. The driver's keys are not recorded, so it replays scripted bots and scenarios, not a human drive)
- [x] Attempts scoreboard (every finished match, newest first, notes, best/average/record/trend, CSV)
- [x] Strategy board (pen, numbered markers, move, erase, undo, named boards, PNG; "Start here" fills the start position)
- [x] Screenshots and videos with overlays (View menu: score and match time burned into the capture)
- [x] Report embedded in the repo (Analysis tab: "Report into project" writes crucible/reports/*.html in the robot project, ready to commit)

## Developer and CI
- [x] Headless mode in CI (`.github/workflows/ci.yml`: typecheck, unit tests, build, and the UI suites under a virtual display; `npm run batch` runs robot-code batches headless where a JDK and the robot project exist)
- [x] Plugin / game-module loader (.js files in the games folder appear in the Game list; `app/examples/game-plugin.js` is a working example; packaged app only)
- [x] UI test suites in the repo (`app/e2e`)
- [x] Local API (opt-in HTTP on 127.0.0.1:5812 with a token: status, start, stop, reset, play, pause, step, preset, set, attempts. HTTP only: no WebSocket stream)
