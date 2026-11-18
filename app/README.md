# BALTA Crucible app

Electron + TypeScript + three.js + Rapier. BALTA Crucible runs your real FRC robot code against a physics simulation of the robot and the REBUILT field, and analyses what happens: the app is the physics authority, your robot program keeps running its own control loops and gets motor, encoder and gyro values back. It is also a log viewer (live NetworkTables 4 or `.wpilog`) with a 3D view and plots.

**Status.** Everything in the plan (milestones M0 to M13 in [docs/PLAN.md](../docs/PLAN.md)) and every item of [docs/IDEAS.md](../docs/IDEAS.md) is built and tested. The things to keep in mind before trusting a number from it:

- **The physics has not been validated against the real robot.** Mass, tire friction, bumper friction, FUEL drag, bounce and spin values are estimates, tagged `GUESS` in `robots/offseason/robot.yaml`. The calibration tools can fit the shot and drive values to measured data, but no real data has been fitted yet. See *Trusting the numbers* below.
- **The vision camera** sends the robot code a simulated AprilTag pose (bridge message 9), but the robot library does not read it yet; the tag layout is assumed.
- **Windows and macOS packaging** and the Windows/macOS self-update paths are written but have not been run on those systems (they are built and tested on Linux only). The Linux package and its self-update are tested end to end.

## Install

- **Download.** Every release on the repository's Releases page has a Windows installer (`BALTA-Crucible-Setup-<version>.exe`), a Linux archive (`BALTA-Crucible-<version>-linux-x64.tar.gz`) and a macOS zip per processor type (`...-mac-arm64.zip` for Apple silicon, `...-mac-x64.zip` for Intel), with `SHA256SUMS.txt`. Releases are made automatically, see [docs/RELEASING.md](../docs/RELEASING.md).
  - **Windows:** run the installer (Start Menu shortcuts, one in `2026 WPILib Tools` when that folder exists, optional desktop shortcut, Add/Remove Programs entry). The installer is not code-signed, so SmartScreen may ask you to confirm ("More info" > "Run anyway"). Optional pages: **Robot project** (where your robot code is; the app writes `%APPDATA%\BALTA Crucible\crucible.config.json` so Launch robot works) and **Patch a project?** (adds the bridge to that project with backups, see [docs/ROBOT_INTEGRATION.md](../docs/ROBOT_INTEGRATION.md)). Silent install: `Setup.exe /S /ROBOT=<project> /PATCH=1 /D=<install folder>` (`/D=` last). English and Turkish.
  - **Linux:** unpack the archive anywhere you can write to (the app updates itself in place, which needs that) and run `./BALTA-Crucible`; `balta-crucible.desktop` is a launcher entry. The archive has no setuid sandbox helper, so the launcher starts the app with `--no-sandbox` unless `chrome-sandbox` is root-owned and setuid.
  - **macOS:** unzip, move `BALTA Crucible.app` where you like (`/Applications` works if your account can write there, which self-update needs). The app is signed ad hoc, not with an Apple Developer ID and not notarised, so the first start needs right-click > Open (or `xattr -dr com.apple.quarantine "BALTA Crucible.app"`).
- **Self-update.** On start (at most once a day; switch it off in Preferences) the app looks for a newer release and says so with a toast; **About > Check for updates > Install the update** downloads the file for your platform, checks it against the release's `SHA256SUMS.txt` (and its Ed25519 signature when signing is set up), quits, swaps itself and starts the new version. Nothing is downloaded until you press Install. A copy that cannot write its own folder, or a development run, offers the release page instead. Details and limits: [docs/RELEASING.md](../docs/RELEASING.md).
- **From the source folder.** `npm run app` builds if the sources changed and starts the app (Windows: `powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1` makes a Start Menu shortcut that does the same; `-Desktop`, `-Remove`).
- **Patch a robot project from the command line:** `npm run integrate-robot -- <project>` checks, add `--apply` (and `--backup`) to patch.

The built app serves its page and the robot model from a loopback-only server in its own process and allows one window at a time.

## Run from source

```bash
npm install
npm run dev          # Electron window (renderer served by Vite, so the robot model is available)
npm run web          # renderer only, in a normal browser at http://localhost:5174 (quick checks)
npm run app          # build if needed, then start the app (what the shortcut does)
npm test             # unit tests (vitest)
npm run typecheck
npm run e2e          # UI tests against the real app under a virtual display (see docs/TESTING.md)
npm run package      # package for this platform into dist-release/ (see docs/RELEASING.md)
npm run batch -- runs/rebuilt-cycle.json     # scripted runs with robot code, headless (needs the robot project and a JDK)
npm run calibrate    # fit the shot and drive models to measured CSV files
```

If Electron reports "Electron uninstall", its binary was not downloaded; run `node node_modules/electron/install.js`. Testing is described in [docs/TESTING.md](../docs/TESTING.md).

## Using it

The side panel has five tabs (keys 1 to 5): **Session** (the sim: game, opponent, alliance, start position, step, seed, presets, data), **Robot** (launch the robot code, log, testing tools), **Topics** (the signals to plot), **Analysis** and **Tune**.

- **Live:** start the robot sim (`./gradlew simulateJava`), enter the host (default `127.0.0.1`) and press Connect. The app subscribes to every topic on port 5810 and reconnects by itself.
- **Log:** Open log… (the last eight are under **Recent files**) or drop a `.wpilog` on the window. Space plays and pauses, the slider and a click on the plot seek. Truncated logs (power loss) open with every complete record.
- **3D view:** the robot pose and the component poses follow the two pickers in the top left (chosen automatically: `Swerve/Pose`, `Mechanism3d/Components`). Orbit with the left mouse button, pan with the right one.
- **Plot:** click a numeric topic to add or remove it; each line is decimated to 6000 points. **CSV** and **PNG** export every sample or the chart.
- **Reference log** (Data card): a second `.wpilog` (a real match, say) drawn dashed on the plot, listed under its own heading in Topics; **Shift** moves it in time to line it up with the sim.

### Keyboard

Press **?** (or the keyboard button in the title bar) for the list, **Ctrl+K** for the command palette (every action below, presets, language and colour switches). Plain keys are off while you type in a box; the driving keys are never shortcuts.

| Key | Action | Key | Action |
|---|---|---|---|
| Space | Play / pause | 1 to 5 | Session, Robot, Topics, Analysis, Tune |
| . | Step 10 ms (paused) | P | Fold the sim panel |
| Ctrl+Enter | Start / stop the sim | F | Focus the robot |
| Shift+R | Reset the sim | C / Shift+C | Next / previous camera |
| ← / Shift+← | Back 1 s / 5 s (scripted robot) | M | Ruler |
| B | Scoreboard overlay | T | Dark / light theme |
| G | Controls (gamepad, driving keys) | Ctrl+K | Command palette |
| N / Shift+N | Next / previous error in the log | Ctrl+L / Ctrl+F | Clear / filter the log |

Driving the robot (sim with robot code): **W S** forward and back, **A D** strafe, **Q E** rotate, **J K** the A and B buttons, **L H** the right and left triggers; a gamepad works too (standard mapping, presented to the robot as an Xbox controller on port 0). The keys can be rebound and the gamepad remapped in **Controls…** (G).

## Session tab: the simulation

**Start sim** runs the engine in a Web Worker. Games: the made-up **Test game** (8 x 5 m, a goal bin, 30 balls dropped from a seeded layout), **REBUILT** (the 2026 field: guardrails, walls, both HUBS, the BUMPS, 408 FUEL in the neutral zone as in the manual; assumptions in [rules/REBUILT_RULES_EXTRACT.md](../rules/REBUILT_RULES_EXTRACT.md)), or a **game plugin** (see below).

- **Modes** (Robot tab): *Scripted robot* (a built-in lap, no robot code), *Robot code (real time)* (Mode A: your robot program drives, 1x speed) and *Robot code (lockstep, Mode B)* (the robot's clock is paused and moves only when the app steps it: repeatable and faster than real time).
- **Transport:** Play/Pause, speed (0.25x to 8x, `max` in lockstep), Step (10 ms), Reset (with the seed box), **Save state / Load state** (three slots). The scripted sim keeps a snapshot every half second for the last minute: **⟲ 1 s** / **⟲ 5 s** (or ← / Shift+←) rewind exactly that much, a click on the timeline goes back to that moment. With robot code the program cannot be rewound.
- **Alliance and start position:** red starts on the far side facing the other way; X / Y / Yaw override the default. Opponents: a blocker, a red cycler, a blue ally cycler, ally + red cycler.
- **Presets:** save the game, mode, opponent, alliance, start position, step, seed, battery, faults, vision and breakpoints under a name and load them with one click (or from Ctrl+K).
- **The panel** at the top right of the 3D view shows phase, sim time and score in its header (click to fold; drag to move, double-click to reset). Rows are grouped (Match, Field, Game, Robot, Robot link, Mechanisms, Determinism); hovering a row explains it. The **state hash** at the bottom is the same at the same step on every run, in Node and in the app, and restoring a saved state replays the identical future. The sim also publishes `/Sim/*` topics.
- **3D tools:** the **Camera** select (Overview, Top-down, Driver chase, Follow robot, Blue HUB, Red HUB); **View ▾** (collision box, intake volume, scoring volumes, rules zones, robot trail, shot arcs and landing spots, scoreboard, robot-camera inset, and *score and timer in screenshots and video*); **Ruler** (two clicks on the floor). The camera and record buttons in the title bar save a PNG or a WebM of the 3D view.
- **Timeline** above the transport: the match phases to scale, score (blue above, red below), foul, impact and shot markers with tooltips.

## Robot tab: robot code in the loop

1. Pick the mode, the robot project (**Choose…**, the last five are under **Recent projects…**; it needs a `gradlew`) and press **Launch robot** (desktop app only). It runs `gradlew simulateJava --no-daemon` there with `CRUCIBLE_BRIDGE=1` (lockstep adds `CRUCIBLE_MODE=lockstep`). Or start the robot yourself: `CRUCIBLE_BRIDGE=1 ./gradlew simulateJava`. The Crucible bridge and the WPILib sim GUI do not mix. **Check project** lists what is ready and what is missing (gradlew, Java, the bridge library and its hook, the sim GUI guard, the emulation layer for lockstep).
2. **Start sim** (Session tab) connects to the robot over the bridge (WebSocket port 5811, plus NetworkTables 5810 for the component poses). **Enable** and the Teleop/Auto/Test picker are the Driver Station. **Start match** (REBUILT) resets the engine and runs the field system: the robot is enabled in AUTO and TELEOP and disabled in between and after, and receives the match time and the Game Data character.
3. A status line says what the robot process is doing (Starting, Building with a bar and the task count, Running, Stopped, Exited, Failed with the reason). **Relaunch** stops and starts again; **Also start the sim when launching** presses Start sim for you.
4. **Gradle output** log: Errors / Warnings / Info toggles, ▲ ▼ (or N / Shift+N) between errors, All / Build / Robot tabs, clickable file references (they open the file at that line in your editor: set `editor` in `crucible.config.json`, for example `code --goto {file}:{line}`), Follow, Copy, Save, Clear, and **Past runs…** (the last 20 are kept). **Extra environment** passes `KEY=VALUE` lines (such as `JAVA_HOME`) to Gradle and the robot.
5. **Robot testing** card: a battery model that sags under load; things that go wrong (brownout at a voltage, latency, sensor noise, dropped CAN ids); a mechanism inspector (volts, speed, position, current); **Controls…**.
6. **Test scenarios**: a scripted driver (forward, strafe, spin, climb the BUMP) plays sticks against your robot code and checks where the robot ends up; each run starts a fresh sim and takes the keyboard from you.
7. **Vision camera**: a simulated AprilTag camera on the robot (assumed tag layout). The 3D view shows the tags (green when seen), the view cone and the reported pose (amber, joined to the true position); the robot is sent the tags and a noisy pose over bridge message 9 ([docs/NT_CONTRACT.md](../docs/NT_CONTRACT.md) section 15). The robot library does not read it yet.

Robot-code details: the drivetrain, all seven Talon mechanisms and the swerve run under the app's physics, defined in `robots/offseason/robot.yaml` (the readout lists any mechanism the robot has that the file does not). Drivetrain numbers come from `TunerConstants.java`; mass and friction are guesses until measured. Wheels that keep driving against a wall slip, so the robot's wheel odometry runs ahead of its real position; the Pigeon gets the real tilt (the chassis acceleration is computed but Phoenix 6's `Pigeon2SimState` has no setter for it).

**Lockstep (Mode B)** replaces the Talon firmware loops with a Java emulation (`EmuTalon`) and the swerve control with `EmuSwerve`, so two runs of the same timed inputs give the same physics state at every sample, at 1.5x (1 ms step) to about 4x (5 ms) real time. Vision is off in this mode. Scripted runs tie inputs to the sim clock with `session.at(simTime, fn)`. The robot accepts one app at a time (the newest connection wins).

## Analysis tab

- **Match summary:** score, breakdown (Auto / Teleop / Endgame / Fouls), shots and accuracy, pickups, pickup-to-launch times, distance, top speed, impacts, fouls with the rule broken, a pickup-to-launch histogram, a shot map (scored / missed, aim lines, the robot's path) and the event feed with filters. A summary opens when a match ends (switch it off with the box in the tab).
- **Exports:** **Save report…** (standalone HTML), **Events CSV…**, **Save run (.json)…** (the `report.json` shape `npm run batch` writes), **Save .wpilog…** (everything recorded, opens here, in AdvantageScope or any WPILOG tool), **Report into project** (writes the HTML to `crucible/reports/` in the robot project so it can be committed).
- **Share:** **Share run…** writes one `.run.json` with the set-up and the result; **Open shared…** restores the settings and loads the result as run A. The driver's keys are not recorded: bots and test scenarios repeat from the set-up, a human drive does not.
- **Attempts:** every match that reaches its end, with a note each, best / average / record / trend, and CSV.
- **Strategy board:** draw paths, drop numbered markers, keep boards by name, save a PNG, and turn a spot or the first path into the start position.
- **Compare runs:** two `report.json` files (or the current run) in a table with who did better, plus score and path charts.
- **Pause when…:** breakpoints on a shot, a pickup, a score, a foul, a phase change, an impact over a speed, or a sim time.
- **Seed sweep:** the scripted match with many seeds in a worker (mean ± spread of both scores, wins, every run). Test game and REBUILT only. For robot code use `npm run batch` with `seeds`.

## Tune tab

- **Physics sliders:** tire friction, robot mass, shot efficiency, backspin, bumper friction, with the robot definition's value as the default (per-row **default**, or **Reset all**). Friction and the shot values act at once in a running sim; mass and bumper friction apply at the next Reset. Floor presets set the tire friction. Changed values are remembered, mark the tab with a dot, and every new sim (and the seed sweep) starts with them.
- **Sensitivity:** moves each value 10% down and up from what is set now and reports how three quick probes change: the speed 0.25 s after a full-power start (grip-limited: tire friction matters, mass cancels out), after a gentle 3 V start (motor-limited: mass matters), and the range of one fixed shot (efficiency, backspin). It measures these probes, not whole matches, so a value none of them touches (bumper friction) shows "no effect on these probes".
- **Calibration:** pick Shots or Drive, paste or open the measured CSV (formats in `src/calibration/data.ts`; **Example** makes made-up data), **Fit** shows the error before and after, the fitted values, which parameters the data does not pin down and the residuals. **Apply to the sim** moves the sliders, **Copy yaml** gives the lines for `robot.yaml`, **Report…** saves an HTML report. `npm run calibrate -- example | shots <csv> | drive <csv> [--volts 12] [--mass] [--apply]` does the same from the command line.
- **What is measured:** the `GUESS` / `CODE` / `CAD` / `FIT` tags in `robot.yaml`'s comments as a list, so you can see which numbers are still placeholders.

### Trusting the numbers

The shot model computes the exit speed from the flywheel (`efficiency * 2π * wheel radius * rps`), flies the ball with quadratic drag and Magnus lift, and bounces it with a speed-dependent foam restitution. Calibration fits only efficiency and backspin, to measured **range**. Not covered: flight **time** (computed but never compared with a measurement), the real flywheel's spin-up and sag when a ball passes (the shooter velocity loop was not compared with the real controller), ball compression and slip in the shooter, and real shot scatter (the sim is deterministic for a seed). Use the sim for map logic, relative comparisons and bug-hunting; use measured shots (fit on some, check on shots you held out) before believing a distance to a few centimetres.

## Preferences and quality of life

- **Toasts** (bottom right) carry every message; the status bar line still shows the latest. Click to dismiss; a repeated message shows a counter.
- **Preferences** (gear in the title bar): **Turkish interface** (the fixed labels; messages built at run time stay English), **colour-blind-safe colours** (blue and orange, in the interface and the 3D field zones from the next sim start; robot and bumper colours are unchanged), **larger text** (a 1.2x window zoom), **look for updates at start**, the **local API** and the **game plugins folder**.
- **Remembered:** game, mode, opponent, step, seed, host, view toggles, log toggles, tune values and more are kept between runs.
- **Game plugins:** put a `.js` file in the games folder (Preferences > Open the game plugins folder) and restart; it appears in the Game list as "name (plugin)". The file exports a function that returns a game module (`GameModule` in `src/engine/types.ts`; a working example is `examples/game-plugin.js`). A plugin runs inside the simulation with its permissions: use only files you trust. Plugins load in the built app, not in `npm run dev`, and the seed sweep does not support them.
- **Local API** (off by default): HTTP on `127.0.0.1:5812`; every request needs `Authorization: Bearer <token>` (shown in Preferences; a new token cuts off the old one) and requests from web pages are refused. `GET /api/status`; `POST /api/command` with `{"action": "start" | "stop" | "reset" | "play" | "pause" | "step" | "preset" | "set" | "attempts"}` (`preset` needs `name`, `set` needs `id` and `value`). HTTP only: there is no event stream.

## Scripted runs, bots, batch

A run script (JSON, see `runs/rebuilt-cycle.json`) lists timed driver actions (`ds`, `sticks`, `buttons`, `match`) in simulated time. `npm run batch -- runs/rebuilt-cycle.json` starts the robot project in lockstep for each script, runs it and writes `runs/out/<name>/report.{json,md,html}` plus a comparison `summary.md`; a file may list several scripts or give `seeds` to repeat each one. Two runs of one script give byte-identical reports. The report has score over time, shots (fired, reached a HUB, accuracy), bursts and cycle times, pickup-to-launch times, distance, top speed, contacts, a drive path and a shot map. In a script, `bots` takes routes or cycles for other robots (pick up FUEL, drive to a firing spot, fire at the bot's own HUB, with a seeded spread); keep the straight line to a firing spot clear of the HUB.

## Engine and physics notes

Engine layout (`src/engine`, no DOM): `engine.ts` (Rapier world, fixed step, plug-in host, scoring, match flow, snapshots), `types.ts` (the `GameModule` interface), `rng.ts` (seeded RNG and state hash), `worker.ts` + `protocol.ts` (real-time loop and messages), `setup.ts` (what a simulation is made of, shared by the live worker and the sweep). Material coefficients are factors that multiply with the surface they touch (a ball restitution of 0.55 on a floor of 1.0 rebounds to 0.55² of the drop height).

- **Balls** are real rigid bodies (restitution, friction, rolling damping, quadratic air drag, Magnus lift, CCD). With robot code the intake catches them into a virtual queue that rides the stages (beam breaks `#` = blocked) to the shooter, which launches a rigid body with the computed state. Resting FUEL is frozen to keep 408 pieces real time ([docs/PERFORMANCE.md](../docs/PERFORMANCE.md)).
- **Bumpers:** a chamfered footprint with mass and yaw inertia (`chassis.moi`, `friction`, `restitution`, `chamfer`; guesses). **BUMPS:** the game module supplies the floor height; a plane through the four module contact points gives height, pitch and roll (drawn, and sent to the Pigeon), and the slope pushes on the chassis. **Other robots** are traction-limited like any robot (`mu * m * g`). Every contact the drive did not cause is a `robot-impact` event.
- **Determinism:** the same seed and inputs give the same state hash at the same step.

## Brand and robot model

The name is BALTA Crucible. The images (emblem, wordmark, icons) are built from the BALTA Robotics logo file by `tools/build-brand-assets.mjs`; colors are gold #cb8e00, silver #dcdcdc, black #010101. The theme button switches dark and light (remembered); reports follow the reader's light or dark setting. The icons in `build/` are not committed: `npm run icons` makes them from the brand emblem when they are missing (commit your own `build/icon.png` and `icon.ico` with `git add -f` to use exact ones).

The robot model folder uses the AdvantageScope layout (`model.glb`, `model_N.glb` per component, `config.json`). It is not stored in this repo (about 26 MB). It is found in this order: `CRUCIBLE_MODEL_DIR`, `modelDir` in `crucible.config.json` (git-ignored; the installer writes one under `%APPDATA%\BALTA Crucible`), then the sibling robot repo at `../../OffSeasonCode/OffSeasonCode/advantagescope/Robot_OffSeason`. Both the dev server and the built app serve it at `/model/*`; without it the app shows no robot model but everything else works.

To check the renderer in a plain browser against a real log: `CRUCIBLE_SAMPLE_LOG=<path> npm run web`, then in the console `fetch('/dev-sample-log').then(r => r.blob()).then(b => crucible.openLogFile(new File([b], 'x.wpilog')))`.

## Layout

| Path | Role |
|---|---|
| `src/main`, `src/preload` | Electron main process: window, loopback server (`static-server.ts`), robot launcher (`robot.ts`), run logs, preflight, recent files, project reports, local API (`api.ts`), update check (`update.ts`) and self-update (`updater.ts`, key in `update-key.ts`) |
| `src/renderer/src/main.ts` | Wiring of the page; the features live in `src/renderer/src/lib/` |
| `src/renderer/src/lib` | Viewer (`wpilog.ts`, `structs.ts`, `store.ts`, `nt4.ts`, `scene.ts`, `plot.ts`), sim UI (`simsource.ts`, `simmodel.ts`, `simpanel.ts`, `viewfx.ts`, `visionview.ts`), robot tab (`robotrun.ts`, `robotlog.ts`, `scenarios.ts`, `controls-ui.ts`), analysis (`analysis.ts`, `analysis-view.ts`, `compare*.ts`, `attempts.ts`, `runfile.ts`, `strategy.ts`, `wpilogwriter.ts`), tune (`tune-ui.ts`, `guesses.ts`), chrome (`chrome.ts`, `quality.ts`, `team.ts`, `toast.ts`, `cmdpalette.ts`, `presets.ts`, `i18n.ts`, `a11y.ts`, `versions.ts`, `shortcuts.ts`, `keybinds.ts`) |
| `src/engine`, `src/games` | Physics engine and game modules (test game, REBUILT); `plugin.ts` checks outside game modules |
| `src/engine/bridge`, `drivetrain.ts` | Sim bridge (frames, WebSocket transport, NT client, faults, session) and the swerve model |
| `src/engine/balls.ts`, `mechanism.ts`, `motors.ts`, `vision.ts`, `tuning.ts`, `sweep.ts`, `breaks.ts` | Ball model, rotary mechanisms, motor constants, AprilTag camera, tunable values, seed sweep, breakpoints |
| `src/calibration` | Shot and drive fits, the sensitivity probes, calibration reports |
| `robots/offseason/robot.yaml`, `src/robots/` | Robot definition and its loader/checker |
| `scripts/` | Packaging (`package.mjs`, `build-installer.mjs`, `make-icons.mjs`), releases (`release-notes.mjs`, `sign-release.mjs`, `update-keys.mjs`), `smoke-packaged.mjs`, `batch.mjs`, `calibrate.mjs`, `integrate-robot.mjs`, `launch.mjs` |
| `installer/` | NSIS installer script and art |
| `examples/` | A working game plugin |
| `tests/`, `e2e/` | Unit tests and UI tests ([docs/TESTING.md](../docs/TESTING.md)) |
| `../.github/workflows` | `ci.yml` (checks and UI tests on every push) and `release.yml` (releases) |

## Known limits

- The physics is unvalidated against the real robot (see *Trusting the numbers*); mass, friction and the ball values are estimates.
- Only struct types made of doubles are decoded from logs and NetworkTables (poses, translations, rotations, speeds, module states); live data keeps the last 60 000 samples per topic.
- The vision message is sent but the robot library does not read it; the AprilTag layout is assumed.
- TOWER scoring and the endgame climb are not in the REBUILT module (see the rules extract).
- The Turkish interface covers fixed labels only.
- Packaged Windows and macOS builds and their self-update paths have not been run on those systems.
- Game plugins do not load in `npm run dev`.
