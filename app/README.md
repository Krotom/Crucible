# BALTA Crucible app

Electron + TypeScript + three.js. At this stage the app is a viewer for an existing robot: it connects to a running
robot over NetworkTables 4 or opens a `.wpilog`, shows the robot in 3D and plots numeric topics. It also runs the
physics engine core on a test game (M2); the bridge to your robot code comes in M3.

## Run

```bash
npm install
npm run dev        # Electron window (renderer served by Vite, so the robot model is available)
npm run web        # renderer only, in a normal browser at http://localhost:5174 (handy for quick checks)
npm test           # parser, struct and NT4 client tests
npm run typecheck
```

If Electron reports "Electron uninstall", its binary was not downloaded; run `node node_modules/electron/install.js`.

## Install and launch as a desktop app

- **Installer.** `npm run installer` builds `dist-installer/BALTA-Crucible-Setup-<version>.exe` (needs NSIS; found in `C:\Program Files (x86)\NSIS` or through the `MAKENSIS` variable). It installs the app with its own Electron runtime (no Node.js needed), adds Start Menu shortcuts (including one in the `2026 WPILib Tools` folder when it exists, with the BALTA icon), an optional desktop shortcut, and an Add/Remove Programs entry.
  Two optional pages: **Robot project** (where your robot code is; the app writes `%APPDATA%\BALTA Crucible\crucible.config.json` so Launch robot works) and **Patch a project?** (adds the bridge to that project with backups, see `docs/ROBOT_INTEGRATION.md`). Silent install: `Setup.exe /S /ROBOT=<project> /PATCH=1 /D=<install folder>` (`/D=` last). English and Turkish.
  Later, **Patch a robot project** in the Start Menu does the same for any project.
- **From the source folder.** `npm run app` builds if the sources changed and starts the app; `powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1` creates a Start Menu shortcut (in `2026 WPILib Tools`) that does the same (`-Desktop` for the desktop too, `-Remove` to undo). Use one or the other: both create `BALTA Crucible.lnk` in the WPILib Tools folder.
- The built app serves its page and the robot model from a loopback-only server in its own process and allows one window at a time.
- **Patch a robot project from the command line:** `npm run integrate-robot -- <project>` checks, add `--apply` (and `--backup`) to patch.

## Using it

- **Live:** start the robot sim (`./gradlew simulateJava`), enter the host (default `127.0.0.1`) and press Connect.
  The app subscribes to every topic on port 5810 and reconnects by itself.
- **Log:** Open log… or drop a `.wpilog` on the window. Space plays and pauses, the slider and a click on the plot
  seek. Truncated logs (power loss) open with every complete record.
- **3D view:** the robot pose and the component poses follow the two pickers in the top left; they are chosen
  automatically (`Swerve/Pose`, `Mechanism3d/Components`). Orbit with the left mouse button, pan with the right one.
- **Plot:** click a numeric topic in the list to add or remove it; each line is decimated to 6000 points.

## Robot tab, shortcuts, remembered settings

- **Run status.** Under Launch robot a line says what the robot process is doing, read from its output: Starting, Building (with a moving bar and the Gradle task count), Running (waiting for / connected to the sim), Stopped, Exited, or Failed (exit code or "Build failed"), with the elapsed time. **Relaunch** (while running) stops the robot, waits for it to exit, and launches it again. **Also start the sim when launching** presses Start sim for you (robot-code modes only); the sim waits for the robot program to connect.
- **Log.** Errors / Warnings / Info toggles hide a severity (the app's own lines and BUILD SUCCESSFUL always show); the ▲ ▼ buttons (or **N** / **Shift+N**) jump between errors, counting a message and its stack trace once.
- **Project.** The row at the top of the Robot code card shows the robot project that Launch robot runs; **Choose…** picks another folder (it needs a gradlew), the last five are offered under **Recent projects…**. The choice is kept in the settings folder and wins over `app/crucible.config.json`. **Check project** lists what is ready and what is missing (gradlew, Java, the bridge library and its hook, the simulation GUI guard, and for lockstep the emulation layer); Launch robot runs the same checks and only refuses when there is no project or no Java.
- **Extra environment.** `KEY=VALUE` lines are passed to Gradle and the robot (`JAVA_HOME`, flags ...); the variables the bridge needs are always set by the app.
- **Log tabs and links.** All / Build / Robot split Gradle's output from the robot program's own prints. File references in stack traces and compiler messages are links: a click opens the file at that line (the `editor` command in the settings `crucible.config.json`, for example `code --goto {file}:{line}`; VS Code if it is installed, else the default app).
- **Past runs.** Every run is also saved in the settings folder (the last 20); **Past runs…** puts one back into the log.
- **Shortcuts.** Press **?** (or the keyboard button in the title bar) for the list: Space play/pause, **.** step 10 ms, Ctrl+Enter start/stop the sim, Shift+R reset, 1/2/3 tabs, P fold the sim panel, F focus the robot, T theme, Ctrl+L clear the log, Ctrl+F filter the log. Plain-key shortcuts are off while typing in a box, and the driving keys (W A S D Q E J K L H) are never shortcuts.
- **Remembered.** Game, robot mode, opponent, step, seed, NT host, the auto-start option and the log toggles are kept between runs.

## Analysis tab, timeline and 3D view tools

- **Analysis tab** (key 4): match summary (score, breakdown by Auto / Teleop / Endgame / Fouls, shots and accuracy, pickups, pickup-to-launch times, distance, top speed, impacts, fouls with the rule that was broken), a pickup-to-launch histogram, a shot map (scored / missed, aim lines, the robot's path) and the event feed with filters. **Save report…** writes a standalone HTML report, **Events CSV…** the event list. When a match ends a summary opens (switch it off with the box in the tab).
- **Timeline** above the transport: the match phases to scale, score (blue above, red below), foul, impact and shot markers with tooltips, and the current time.
- **Camera** (HUD select, **C** / **Shift+C**): Overview, Top-down, Driver (chase), Follow robot, Blue HUB, Red HUB. **View ▾** switches the collision box, intake volume, scoring volumes, rules zones and center line, robot trail, shot arcs and landing spots, scoreboard (**B**) and a robot-camera inset (front or top-down). **Ruler** (**M**): click two points on the floor for the distance. The sim panel shows the distance to your HUB; drag its header to move it, double-click to put it back.
- **Alliance and start position** (Session tab): red starts on the far side facing the other way; X / Y / Yaw override the default. The opponent list also has a blue ally cycler and ally + red cycler for practice matches.

## Replay and export

- **Rewind.** The scripted sim keeps a snapshot every half second for the last minute. **⟲ 1 s** / **⟲ 5 s** (or **←** / **Shift+←**) take it back exactly that much simulated time; a click on the timeline goes back to that moment (it cannot skip ahead of what was simulated). Stepping on from a rewound moment gives the same state hashes again. With robot code the program cannot be rewound: the buttons stay off.
- **Slots.** Save state / Load state use one of three slots (the **Slot** box).
- **Export.** **CSV** and **PNG** (next to Clear plot) save the plotted topics (every sample) or the chart with its legend. **Save .wpilog…** (Analysis tab) writes everything recorded in the sim as a WPILOG that opens here, in AdvantageScope or any WPILOG tool (the pose picker finds the sim's robot pose by itself). **Save run (.json)…** writes the run in the same report.json shape `npm run batch` writes.
- **Compare runs** (Analysis tab): load two report.json files (or use the current run) for a table with who did better (score, accuracy, cycle times, impacts ...) and score and path charts.
- **Seed sweep** (Analysis tab): the scripted match played with many seeds in a worker: mean ± spread of both scores, wins, every run. For robot code use `npm run batch` with `seeds`.
- **Reference log** (Data card): a second .wpilog (for example a real match) whose topics are listed under their own heading in the Topics tab and drawn dashed on the plot; **Shift** moves it in time to line it up with the sim.

## Tune tab

- **Physics sliders:** tire friction, robot mass, shot efficiency, backspin and bumper friction, with the robot definition's value as the default (the per-row **default** button, or **Reset all**). Friction and the shot values act at once in a running sim; mass and bumper friction apply at the next Reset. Floor presets (slick, worn, carpet, new carpet) set the tire friction. Changed values are remembered, mark the tab with a dot, and every new sim (and the seed sweep) starts with them.
- **Calibration:** pick Shots or Drive, paste or open the measured CSV (formats in `src/calibration/data.ts`; **Example** makes made-up data), **Fit** runs the same fits as `npm run calibrate` in a worker and shows the error before and after, the fitted values, which parameters the data does not pin down and the residuals. **Apply to the sim** moves the sliders, **Copy yaml** gives the lines for `robots/offseason/robot.yaml`, **Report…** saves an HTML report.
- **What is measured:** the `GUESS` / `CODE` / `CAD` / `FIT` tags in `robot.yaml`'s comments as a list, so you can see which numbers are still placeholders.

## Simulation (M2)

**Start sim** runs the engine in a Web Worker with the `game-test` module (a made-up 8 x 5 m field: walls, a block, a goal bin that
scores 2 points in auto and 1 in teleop, and 30 balls dropped from a seeded random layout) and a scripted robot that drives
a lap through the pile. Balls are real rigid bodies (restitution, friction, rolling damping, quadratic air drag, CCD), the
robot is a kinematic body that shoves them.

- Play/Pause, speed (0.25x to 8x), Step (10 ms), Reset (with the seed box), Save state / Load state (an in-memory snapshot).
- The panel at the top right of the 3D view shows the phase, sim time and score in its header; click the header to fold the details away (it remembers). The details are grouped (Match, Field, Game, Robot, Robot link, Mechanisms, Determinism) with plain labels, and hovering a row explains it. The **state hash** is at the bottom. The same seed gives the same
  hash at the same step on every run, in Node and in the app; restoring a saved state replays the identical future.
- The sim also publishes `/Sim/*` topics (pose, speed, scores, ball counts) into the topic list and plots.
- The orange wireframe on the robot is its collision box.

Engine layout (`src/engine`, no DOM): `engine.ts` (Rapier world, fixed step 1 ms, plug-in host, scoring, match flow, snapshots),
`types.ts` (the `GameModule` interface), `rng.ts` (seeded RNG and state hash), `worker.ts` + `protocol.ts` (real-time loop and
messages). `src/games/test.ts` is the test game. Material coefficients are factors that multiply with the surface they touch
(a ball restitution of 0.55 on a floor of 1.0 rebounds to 0.55^2 of the drop height).

Not in yet: robot-vs-wall contact (the scripted robot ignores walls), speed-dependent foam restitution, Magnus lift, capture
volumes and shooting (M5), the real robot definition (M4).

## Robot code in the loop (M3)

Choose **Robot code (NT)** as the Mode on the Robot tab: the app is then the physics authority for the real robot program. The robot's
Talons keep running their control loops (Phoenix sim) and publish their applied voltages through the bridge; the app steps a
swerve model (tire forces per module, DC motor models, current limits, the walls and balls of the test game) and returns rotor,
CANcoder and Pigeon states. The robot's own odometry then follows the app's physics.

The frame exchange uses a dedicated local WebSocket (port 5811) served by the robot, not NetworkTables; see the contract.
All seven Talon mechanisms (turret, shooter, feeder, indexer, hood, intake driver and roller) and the swerve run under the
app's physics, defined in `robots/offseason/robot.yaml`; the readout lists any mechanism the robot has that the file does not.

1. On the **Robot** tab pick the mode (Scripted robot, Robot code real time, or lockstep) and the NT host, then **Launch robot** (Electron only): it starts `gradlew simulateJava --no-daemon` in the robot project with `CRUCIBLE_BRIDGE=1` (the project
   folder is `robotDir` in `app/crucible.config.json`, else the sibling repo). The **Gradle output** log below it shows everything the build and the robot print (colored by severity, with a filter, Follow, Copy, Save and Clear; the last 5000 lines are kept). Or start the robot yourself:
   `CRUCIBLE_BRIDGE=1 ./gradlew simulateJava`. The Crucible bridge and the sim GUI do not mix, see the contract.
2. **Start sim** (Session tab) in Robot code mode connects over NT (host box) and shows the robot's status in the readout.
3. **Enable** and the Teleop/Auto/Test picker are the Driver Station. Drive with a gamepad (standard mapping, presented to the
   robot as an Xbox controller on port 0) or the keyboard: W/S forward and back, A/D strafe, Q/E rotate, J/K the A and B
   buttons, L/H the right and left triggers. The robot code's own mapping applies.
4. Reset, Save and Load work as in the scripted sim; the robot's odometry is re-seeded to the robot's new position.

Drivetrain numbers are in `src/robots/offseason.ts`: gear ratios, wheel radius, coupling and module positions come from
`TunerConstants.java`; the mass (52 kg) and tire friction (1.2) are guesses until measured.

## Balls (M5)

With the robot code in the loop, the intake catches balls (the green box is the capture volume), they ride the stages to the shooter, and a ball
launched from the turret flies with drag, spin and foam bounce. The readout shows pieces held, the three beam breaks (`#` = blocked), pieces
caught and shots. In the test game, the elevated cyan "hub" volume at (4.6, 4.0) is where the robot code aims its turret and scores 3 points
in teleop. The ball numbers are in the `ballHandling` section of `robots/offseason/robot.yaml` and are guesses until measured.

## REBUILT and match control (M6)

Pick **REBUILT** next to Start sim. The field has the guardrails, walls, both HUBS (hollow, with the 41.7 in opening) and the BUMPS; FUEL is staged as in the manual (see
`rules/REBUILT_RULES_EXTRACT.md` section 10 for what is assumed; the neutral pile is the manual's 408 FUEL, kept real time by freezing resting FUEL and a 2 ms step, see `docs/PERFORMANCE.md`). In Robot code mode, **Start match** resets the engine and runs the field system: the
robot is enabled in AUTO and TELEOP and disabled in between and after, and it receives the match time and the Game Data character. The readout shows which HUBS are active,
the FUEL counts, the Game Data and the G403/G407 fouls.

## Contact and pushing (M7)

- **Bumpers:** a chamfered footprint with explicit mass and yaw inertia (`chassis.moi`, `friction`, `restitution`, `chamfer` in the robot definition, all guesses). Wall contact multiplies the
  bumper friction with the wall's, bumper against bumper averages them.
- **BUMPS:** the robot climbs them. The game module supplies the floor height (`terrain(x, y)`); a plane through the four module contact points gives the body's height, pitch and roll
  (drawn, and sent to the robot's Pigeon), and the slope pushes on the chassis (`-m g grad h`), so a climb costs energy. The body stays planar for physics.
- **Other robots:** tick **opponent** next to Start sim for a second (red) robot that holds still and can only be pushed. It is traction-limited like any robot (`mu * m * g`): it holds against a push
  up to that force and slides above it. In code, `RobotSpec.others` takes a mass, a footprint, a start and an optional script.
- **Contact feedback:** every contact the drive did not cause is reported as a `robot-impact` event (the speed it changed, and whether it was the field or a robot) once it ends, and shown as `hits`
  in the readout. The Pigeon gets the real tilt (pitch, roll and their rates). The chassis acceleration (impacts included, in g, 8 g limit) is computed too, but Phoenix 6's
  `Pigeon2SimState` has no acceleration setters, so the robot code cannot read it. Wheels that keep driving against a wall slip, so the robot's wheel odometry runs ahead of its real position.

## Lockstep (Mode B, M8)

Pick **Robot code (lockstep, Mode B)** as the Mode on the Robot tab, then **Launch robot** (it starts the robot with `CRUCIBLE_MODE=lockstep`). The robot's clock is paused and moves only when the app sends a Step, the
robot's Talons are a Java emulation (`EmuTalon`) and its swerve drivetrain a Java layer (`EmuSwerve`), so a run is **repeatable** (two runs of the same timed inputs give the same physics state at every sample) and can
go **faster than real time**: the step dropdown sets the simulated time of one exchange and of one physics step (1 ms: 1.5x, 2 ms: 2.5x, 5 ms: 3.5 to 4x real time, measured with the real robot project). The speed
dropdown paces it (`max` is as fast as it goes). Vision is off in this mode (the PhotonVision sim is not repeatable). Scripted runs tie inputs to the sim clock with `session.at(simTime, fn)`; the buttons are wall-clock timed
(interactive, not repeatable). The robot accepts one app at a time (the newest connection wins): close other Crucible windows before a run.

## Scripted runs, bots, capture, calibration (M9 to M12)

- **Scripted runs.** A run script (JSON, see `runs/rebuilt-cycle.json`) lists timed driver actions (`ds`, `sticks`, `buttons`, `match`) in simulated time. `npm run batch -- runs/rebuilt-cycle.json` starts the robot project in lockstep for each
  script, runs it, and writes `runs/out/<name>/report.{json,md,html}` plus a comparison `summary.md`; a file may list several scripts or give `seeds` to repeat each one. Two runs of one script give byte-identical reports.
  The report has score over time, shots (fired, reached a HUB, accuracy), shot bursts and cycle times, pickup-to-launch times, distance, top speed and contacts, a drive path and shot map.
- **Other robots.** The Opponent menu adds a blocker or a red cycler. In a script, `bots` takes routes or cycles (pick up FUEL, drive to a firing spot, fire at the bot's own HUB, with a seeded spread); keep the straight line to a firing spot clear of the HUB.
- **Screenshot and video.** The camera and record buttons in the title bar save a PNG of the 3D view or a WebM recording (the app asks where to save; a browser downloads).
- **Calibration.** `npm run calibrate -- example` writes synthetic example files; `-- shots shots.csv` fits launch efficiency and backspin to measured shots, `-- drive accel.csv [--volts 12] [--mass]` fits tire friction (and mass) to a measured acceleration;
  `--apply` writes the fitted values into `robots/offseason/robot.yaml`. The reports say when a parameter is not pinned down by the data. File formats: `src/calibration/data.ts`. Nothing has been fitted to real data yet.

## Test scenarios and the vision camera

Robot tab, **Test scenarios**: a scripted driver (forward, strafe, spin, climb the BUMP) plays sticks against your robot code and checks where the robot ends up; each run starts a fresh sim, takes the keyboard away from you and shows which checks passed.
Robot tab, **Vision camera**: a simulated AprilTag camera on the robot. The 3D view shows every tag (green when seen), the view cone, rays to the seen tags and the reported pose (amber, joined to the true position so the error shows); the panel gets a Vision row. The robot code is sent the tags and a noisy pose over bridge message 9 (see `docs/NT_CONTRACT.md` section 15). The tag layout is assumed, and the robot library does not read the message yet.

## Brand

The name is BALTA Crucible. The images (emblem, wordmark, icons) are built from the BALTA Robotics logo file by `tools/build-brand-assets.mjs`; colors are gold #cb8e00, silver #dcdcdc, black #010101. The theme button switches dark and light
(the choice is remembered). Reports carry the same header and follow the reader's light or dark setting.

## Robot model

The model folder uses the AdvantageScope layout (`model.glb` for the chassis, `model_N.glb` per component,
`config.json`). It is not stored in this repo (about 26 MB). The folder is found in this order:
`CRUCIBLE_MODEL_DIR`, `modelDir` in `app/crucible.config.json` (git-ignored), then the sibling robot repo at
`../../OffSeasonCode/OffSeasonCode/advantagescope/Robot_OffSeason`. The dev server serves it at `/model/*`; a packaged
build will bundle the model from the robot definition (M4).

To check the renderer in a plain browser against a real log: `CRUCIBLE_SAMPLE_LOG=<path> npm run web`, then in the console
`fetch('/dev-sample-log').then(r => r.blob()).then(b => crucible.openLogFile(new File([b], 'x.wpilog')))`.

## Layout

| Path | Role |
|---|---|
| `src/main`, `src/preload` | Electron shell (thin for now) |
| `src/renderer/src/lib/wpilog.ts` | `.wpilog` reader: indexes records, decodes lazily (a 60 MB log opens in about 0.4 s) |
| `src/renderer/src/lib/structs.ts` | WPILib struct decoding (Pose2d, Pose3d, ...) |
| `src/renderer/src/lib/store.ts` | One data model for log and live sources |
| `src/renderer/src/lib/nt4.ts` | NT4 client |
| `src/renderer/src/lib/scene.ts` | three.js scene in WPILib coordinates (Z up) |
| `src/renderer/src/lib/plot.ts` | uPlot panel |
| `src/engine`, `src/games` | physics engine and game modules (see Simulation) |
| `src/engine/bridge`, `src/engine/drivetrain.ts` | sim bridge (frames, NT client, session) and the swerve model |
| `src/engine/balls.ts` | the hybrid ball model: capture, stages, beam breaks, launch |
| `src/engine/mechanism.ts`, `motors.ts` | rotary mechanism physics and motor constants |
| `robots/offseason/robot.yaml`, `src/robots/` | robot definition and its loader/checker |
| `src/main/robot.ts` | robot process launcher for the Electron main process |
| `tests/` | unit tests (engine: ballistics, drag, bounce, determinism, snapshots, scoring, golden hash); `real-log.test.ts` runs only when `CRUCIBLE_SAMPLE_LOG` is set |

## Known limits (M1)

- The field is a placeholder rectangle (16.541 x 8.069 m); the real field comes with the REBUILT module (M6).
- Only struct types made of doubles are decoded (poses, translations, rotations, speeds, module states).
- A production build (`npm run build`) does not yet serve the robot model; use `npm run dev`.
- Live data is kept as the last 60 000 samples per topic.
