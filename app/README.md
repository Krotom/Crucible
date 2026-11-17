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

## Using it

- **Live:** start the robot sim (`./gradlew simulateJava`), enter the host (default `127.0.0.1`) and press Connect.
  The app subscribes to every topic on port 5810 and reconnects by itself.
- **Log:** Open log… or drop a `.wpilog` on the window. Space plays and pauses, the slider and a click on the plot
  seek. Truncated logs (power loss) open with every complete record.
- **3D view:** the robot pose and the component poses follow the two pickers in the top left; they are chosen
  automatically (`Swerve/Pose`, `Mechanism3d/Components`). Orbit with the left mouse button, pan with the right one.
- **Plot:** click a numeric topic in the list to add or remove it; each line is decimated to 6000 points.

## Simulation (M2)

**Start sim** runs the engine in a Web Worker with the `game-test` module (a made-up 8 x 5 m field: walls, a block, a goal bin that
scores 2 points in auto and 1 in teleop, and 30 balls dropped from a seeded random layout) and a scripted robot that drives
a lap through the pile. Balls are real rigid bodies (restitution, friction, rolling damping, quadratic air drag, CCD), the
robot is a kinematic body that shoves them.

- Play/Pause, speed (0.25x to 8x), Step (10 ms), Reset (with the seed box), Save state / Load state (an in-memory snapshot).
- The top-right readout shows phase, sim time, rate, score, ball counts and a **state hash**. The same seed gives the same
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

Choose **Robot code (NT)** next to Start sim: the app is then the physics authority for the real robot program. The robot's
Talons keep running their control loops (Phoenix sim) and publish their applied voltages through the bridge; the app steps a
swerve model (tire forces per module, DC motor models, current limits, the walls and balls of the test game) and returns rotor,
CANcoder and Pigeon states. The robot's own odometry then follows the app's physics.

The frame exchange uses a dedicated local WebSocket (port 5811) served by the robot, not NetworkTables; see the contract.
All seven Talon mechanisms (turret, shooter, feeder, indexer, hood, intake driver and roller) and the swerve run under the
app's physics, defined in `robots/offseason/robot.yaml`; the readout lists any mechanism the robot has that the file does not.

1. **Launch robot** (Electron only) starts `gradlew simulateJava --no-daemon` in the robot project with `CRUCIBLE_BRIDGE=1` (the project
   folder is `robotDir` in `app/crucible.config.json`, else the sibling repo). Or start it yourself:
   `CRUCIBLE_BRIDGE=1 ./gradlew simulateJava`. The Crucible bridge and the sim GUI do not mix, see the contract.
2. **Start sim** in Robot code mode connects over NT (host box) and shows the robot's status in the readout.
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

Pick **Robot code (lockstep, Mode B)** next to Start sim, then **Launch robot** (it starts the robot with `CRUCIBLE_MODE=lockstep`). The robot's clock is paused and moves only when the app sends a Step, the
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
