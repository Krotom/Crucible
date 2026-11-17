# Crucible — plan

Status: draft v2, 2026-11-17, after M0 (spikes done, all GO). Companion docs: [NT_CONTRACT.md](NT_CONTRACT.md),
[spikes/M0_RESULTS.md](spikes/M0_RESULTS.md), [spikes/S5_LOCKSTEP_TALON.md](spikes/S5_LOCKSTEP_TALON.md), and (to be written) `rules/REBUILT_RULES_EXTRACT.md`.

## 1. Goal

A desktop app that is the **physics authority** for a simulated FRC robot. The robot code runs as it does today
(Java, WPILib sim, Phoenix sim) and publishes motor outputs over NetworkTables. The app simulates the drivetrain, every
mechanism, the game pieces and the field, scores the match by the game's rules, and returns sensor values over NT. It
also visualizes everything in 3D and plays back logs.

Short version: AdvantageScope's visualization plus a game-aware physics engine, in the spirit of MoSim, built so your
real robot code can be tested against it.

**Non-goals for now:** other teams' robots as a product, a hosted or shared service, a browser deployment,
connecting to a real robot, FTC.

## 2. Decisions made

| Topic | Decision |
|---|---|
| Sim authority | **Full authority.** The app simulates drivetrain, mechanisms, balls and field. Robot code supplies motor outputs and consumes sensor values. |
| Talon control loops | **Stay in the robot process** (Phoenix sim, as today). A robot-side bridge replaces `TalonFXSim`: it reads each motor's applied voltage and feeds back rotor position and velocity from the app. |
| Timing | **Two modes, real-time first.** Mode A: real-time with the real Phoenix sim (built first). Mode B: deterministic lockstep and faster-than-real-time using Java-emulated controllers (a later milestone). Reason: see section 3. |
| Stack | TypeScript, three.js, Rapier (WASM) in a Web Worker, Electron. |
| NT interface | Your robot first: a `/SimBridge/` namespace plus topics you already publish. Generalize later if it is worth it. |
| Parameters | A **robot definition file** (YAML) in the app, with CAD-derived defaults and your corrections. |
| Balls vs robot | **Hybrid.** Balls are real rigid bodies outside the robot. Intakes are capture volumes feeding a virtual queue (hopper, indexer, feeder stages). The shooter spawns a ball with the computed launch state. |
| Drivetrain | **Per-module force model** (traction-limited wheel forces summed onto the chassis). |
| Ball flight | Gravity, restitution, rolling friction, plus air drag, spin and Magnus, launch compression and slip, foam deformation on impact. |
| v1 features | Ball physics, scoring and match flow, robot collisions, log playback and plotting. |
| Later | Multiple robots, match analytics, video and screenshot export. |
| Input | Gamepad in the app, app-controlled match state, scripted input. The WPILib sim GUI stays usable as a fallback. |
| Game rules | The engine is game-agnostic; **REBUILT is a plug-in**. Claude researches the rules, you review them before anything is encoded. |
| UI | 3D field with side panels and a timeline. |
| Distribution | Private team tool. Windows first. |
| Pace | Side project, no deadline: milestones, each one stoppable with something usable. |
| Calibration data | None yet. Ship calibration knobs and a fitting workflow now; fit when data exists. |
| Name and home | **Crucible**, private repo `Krotom/Crucible`. |
| Field geometry and rules | Researched from the official game documents at M6 (rules extract), then reviewed by you before encoding. |
| Robot CAD | You supply the full current CAD; until then the definition file carries the values from the robot code. |
| Multi-robot (M10) | Scripted bots first. |
| Robot process | The app launches the robot sim itself (and can attach to one you started). |
| Gamepad | Defaults to the existing `UniversalController` mapping; PathPlanner autos run inside the robot code, so the app does not replay them. |
| Bridge transport | **A dedicated local WebSocket for the frame exchange, in Mode A as well as Mode B.** NT batches updates: M0 measured a ~5 ms floor, and in M4 the real robot sim measured a 14-23 ms round trip, which makes high-gain mechanism loops ring; the WebSocket measures 1-2 ms. NT keeps carrying what people look at. |
| Latency compensation | The app reports each mechanism a short lead ahead (the measured round trip), so the Talon loops see a delay close to a real robot's. |

## 3. What the spike found (S5) and why timing has two modes

We tested whether the Talon FX sim obeys WPILib's paused and stepped clock (`SimHooks.pauseTiming` / `stepTiming`),
which lockstep needs. It does **not**: the Talon control loop runs on a native thread against the wall clock.
Same hood move, 5 ms simulated step, varying wall time per step:

| Wall time per step | Speed vs real time | Reached target at (sim time) | Result |
|---|---|---|---|
| plain real time | 1x | 0.59 s | reference |
| 5 ms | 1.0x | 0.62 s | faithful |
| 2.5 ms | 1.9x | 0.97 s | 65% too slow |
| 1 ms | 4.6x | 2.01 s | badly distorted |
| 0.5 ms | 8.7x | 3.73 s | badly distorted |
| 0 | 79x | never | broken |

Our own physics (a WPILib `Notifier` on the FPGA clock) followed stepped time perfectly; only the Talon loop did not.
Details and method: [spikes/S5_LOCKSTEP_TALON.md](spikes/S5_LOCKSTEP_TALON.md).

Consequences:

- **Mode A (real-time, build first).** Real Phoenix sim, real firmware control behavior. Valid only at 1x speed.
  Not deterministic (wall-clock threads). Good for interactive use, driver practice and tuning.
- **Mode B (later).** The robot's `*IOSim` classes use a Java emulation of the Talon controllers (MotionMagic, PID,
  VoltageOut, current limit) stepped in WPILib time, and the CTRE swerve drivetrain is replaced by a sim drivetrain
  layer. Fully deterministic and faster than real time, for analytics and regression tests. Gives up firmware
  fidelity in that mode. The swerve odometry thread very likely has the same wall-clock problem; that is spike S4.

## 4. Architecture

```
 ┌────────────────────── robot process (Java) ──────────────────────┐        ┌───────────────────── Crucible (Electron) ─────────────────────┐
 │ robot code  ── IO interfaces ── *IOSim ──► sim-bridge library     │        │ main process: robot launcher, file I/O, settings                    │
 │ Phoenix sim (Talon control loops, current limits)                 │  NT4   │ physics worker: NT4 client ─► engine (Rapier + models) ─► NT4       │
 │ WPILib HAL sim + DriverStationSim                                 │◄──────►│ renderer: three.js scene, panels, timeline, plots                   │
 │ NT4 server (localhost:5810)                                       │        │ game module (plug-in): field, pieces, match flow, scoring           │
 └───────────────────────────────────────────────────────────────────┘        └──────────────────────────────────────────────────────────────────────┘
```

Per exchange (Mode A, default every 5 ms, same period `TalonFXSim` uses today):

1. The bridge reads every registered motor's applied voltage and neutral mode and the Driver Station state, and
   publishes one packed **ToApp frame**.
2. The app's physics worker steps the world for that period (1 ms sub-steps, voltages held constant), then publishes
   one packed **FromApp frame**: rotor position and velocity, CANcoders, gyro, digital inputs, battery sag.
3. The bridge applies the latest FromApp frame to each Talon's sim state (`setRawRotorPosition` and friends), the
   CANcoders, the Pigeon, and the digital inputs, then the next exchange begins.
4. At about 60 Hz the worker sends a state snapshot to the renderer for drawing.

The NT4 client lives in the physics worker so the frame loop never waits on the UI thread. The main process only
launches and stops the robot sim and does file I/O. See [NT_CONTRACT.md](NT_CONTRACT.md) for frames, topics and the
handshake.

### 4.1 Components

- **Robot-side bridge** (Java, in the robot project). Generalizes today's `TalonFXSim` into a registry of bridged
  devices: TalonFX, CANcoder, Pigeon 2, digital inputs. Handles frame packing, Driver Station and joystick sim,
  heartbeat and the handshake. In Mode B it also owns the sim clock and the Talon emulation.
- **Engine** (TypeScript package, no UI dependencies). Fixed-step loop, world, robot model, game pieces, interaction
  model (intake, stages, shooter), plug-in host, snapshot and restore.
- **Game modules.** `game-test` (a tiny field, built first so the engine can be developed before any rules exist) and
  `game-rebuilt` (researched, reviewed, then encoded).
- **App.** Electron main, renderer, panels, log reader, recorder.
- **Robot definition** (`robots/offseason/robot.yaml`). Chassis, modules, mechanisms, colliders, capture volumes,
  stages, sensors, plus 3D model references.

### 4.2 Conventions

- WPILib field coordinates in the engine and on the wire (X away from blue wall, Y left, Z up), meters, radians,
  seconds. Convert to three.js axes only inside the renderer.
- Float64 everywhere on the wire and in the engine.
- One fixed physics step (1 ms default) and one exchange period (5 ms default), both configurable; the S1 benchmark
  decides the final numbers.
- Physics runs in a Web Worker; the renderer never blocks it.

## 5. Physics model

### 5.1 Swerve (per-module force model)

For each module: wheel angular velocity comes from the drive motor through the gear ratio (rotor state is what the
Talon sim reads back); the contact patch slip velocity (wheel surface velocity minus ground velocity at the module)
gives a friction force along the slip direction, capped at `mu * N` where `N` is the module's normal load. The module
force acts at the module position; the chassis integrates summed force and torque. Steering follows the steer motor
through its gear ratio. Rolling resistance and a bearing friction term are included.

- Start with static weight distribution for `N`; add load transfer (center-of-gravity height) as a refinement.
- CTRE coupling (steer-to-drive coupling ratio 4.5 in your constants) is applied in the module encoder values we
  return, because the CTRE odometry compensates for it.
- Chassis contact with walls, field elements and other robots goes through Rapier; the resulting motion is what the
  gyro and wheel encoders report back, so the robot code's odometry sees bumps and pushing.

Parameters we do not have yet (mass, moment of inertia, center of gravity height, wheel friction): see section 11.
The known anchor is your own drivetrain constants: 4.39 m/s at 12 V, 2-inch wheels, 7.03125:1 drive, a 120 A slip
current.

### 5.2 Mechanisms

A mechanism is a DC motor model (WPILib motor constants for Kraken X60 or X44, times the number of motors on the
load), a gear ratio, a reflected load inertia, viscous and Coulomb friction, optional gravity torque, hard stops and
a neutral mode (brake versus coast, which matters when the commanded voltage is 0). Three kinds cover your robot:

| Kind | Used for | Output |
|---|---|---|
| Rotary | turret, hood | angle -> rotor position and velocity |
| Linear (pinion) | intake slide | travel along an axis, 78.5 mm per rotation, 8.54 degrees below horizontal |
| Flywheel | shooter, feeder, indexer, roller | speed, rotor position |

Motion limits (hard stops, travel) are in the definition file. Mechanism poses drive the 3D visuals and the intake,
hood and turret colliders and capture volumes.

### 5.3 Balls

- **Outside the robot:** rigid bodies in Rapier with continuous collision detection for fast shots. Sleeping and
  spatial settings are tuned once the game's ball count is known.
- **Ball material model:** restitution that depends on impact speed (a foam curve), tangential friction, rolling
  resistance, quadratic **air drag** `F = 1/2 rho Cd A v^2`, **Magnus** lift from spin `F ~ 1/2 rho Cl A v^2` along
  `omega x v` with a spin-parameter lookup for `Cl`, spin decay, and **foam deformation** as an impact-energy loss that
  grows with impact speed (the visual squish is optional and last).
- **Inside the robot:** virtual. Never simulated as bodies.

### 5.4 Intake, stages, shooter

- **Capture volume:** an oriented box attached to a mechanism frame (the intake moves with the slide). A ball is
  captured if its center is inside the volume, the roller is spinning in the intake direction above a speed
  threshold, and its relative speed is under a limit. A captured ball is removed from the world and added to the
  inventory with its capture time.
- **Stages:** hopper -> indexer -> feeder -> shooter exit, each with a capacity, a transit time derived from the stage
  roller speed, and optional sensors (a beam break that reads true while a ball occupies it, returned as a digital
  input to the robot code).
- **Shooter launch:** when the feeder stage releases a ball, the launch speed is the flywheel surface speed times a
  tunable efficiency (the compression and slip model), the direction comes from the turret yaw and hood angle poses,
  the exit point comes from the robot definition, and spin comes from the contact geometry (backspin from the hood).
  The ball spawns as a Rapier body with that velocity and angular velocity. With no real data yet, efficiency and
  spin gain are knobs; the S-calibration milestone fits them.
- **Contact:** robot colliders (bumper footprint, intake extension, optionally hood and shooter housing) collide with
  balls, field and other robots using collision groups, so balls never collide with robot parts they are supposed to
  be inside.

### 5.5 Determinism

Mode B requires bit-for-bit repeatable runs: fixed time step, a seeded random generator owned by the engine, no wall
clock anywhere in the physics path, and a deterministic Rapier build. Spike S3 verifies this on your machine. Mode A
is not deterministic because the Phoenix sim depends on wall-clock threads.

## 6. Game plug-in and the REBUILT research workflow

The engine never mentions a specific game. A game module provides:

```ts
interface GameModule {
  id: string;
  field(): FieldDefinition;              // static colliders, scoring sensors, visual model refs
  pieces(): GamePieceSpec[];             // geometry, mass, material curves
  initialLayout(rng): PieceSpawn[];      // where pieces start, per match
  matchFlow(): MatchFlowSpec;            // phases, durations, transitions, per-phase rules
  onEvent(e: GameEvent, ctx): Score[];   // intake, launch, sensor-entered, robot-contact, ...
  hud(): HudSpec;                        // what to show on the scoreboard
}
```

Workflow for REBUILT (every step gated by your review):

1. I fetch the official manual and field drawings and write `rules/REBUILT_RULES_EXTRACT.md`: every rule the
   simulation will use (scoring, match phases and timing, any activation or bonus conditions, penalties we model),
   with section references, plus field element dimensions and game piece specs. Ambiguities are listed, not guessed.
2. You review and annotate the extract.
3. Only then do I implement `game-rebuilt` plus tests that mirror the extract.
4. Any rule change updates the extract first.

What the repo already contains is a starting point, not a source of truth: the AprilTag layout
`k2026RebuiltAndymark`, the approximate hub and feeding coordinates in `Constants.FieldConstants`, and a 150 mm fuel
ball in the CAD.

## 7. UI

- **Layout:** large 3D view in the center; left side: signal tree and inspector; right side: panels (score and match
  HUD, robot state, ball stats, plots); bottom: timeline with scrub for playback; top: toolbar (launch and connect the
  robot sim, mode, start, stop and reset the match, recording).
- **3D:** three.js. The robot comes from the same GLB components your AdvantageScope setup uses
  (`advantagescope/Robot_OffSeason/`) plus `model_info.json` for pivots. In live mode the poses come from the physics,
  not from NT. Balls are one `InstancedMesh`.
- **Playback:** a `.wpilog` reader (the format is open and documented) drives the same scene from logged poses. The
  app also logs its own world state so a full run, balls and score included, can be replayed.
- **Bonus:** the app publishes `/SimWorld/...` so AdvantageScope can display the same run.

## 8. Robot definition file (sketch, with values taken from your code)

```yaml
robot: offseason
chassis: { mass_kg: ??, moi_kgm2: ??, cg_height_m: ??, bumper: { length_m: ??, width_m: ?? } }
swerve:
  module_positions_m: [[0.2899, 0.2899], [0.2899, -0.2899], [-0.2899, 0.2899], [-0.2899, -0.2899]]   # 11.415 in
  wheel_radius_m: 0.0508
  drive: { motor: kraken_x60, ratio: 7.03125, can_ids: [20, 23, 26, 29] }
  steer: { motor: kraken_x60, ratio: 26.0909, can_ids: [21, 24, 27, 30], cancoders: [22, 25, 28, 31] }
  coupling_ratio: 4.5
  wheel_cof: { static: ??, kinetic: ?? }
  gyro: { pigeon2: 1 }
mechanisms:
  - { name: turret,  kind: rotary,  motor: kraken_x60, can_ids: [8],  ratio: 46.5,    inertia_kgm2: 0.1 }     # guess
  - { name: hood,    kind: rotary,  motor: kraken_x44, can_ids: [40], ratio: 16.40625, inertia_kgm2: 0.02 }   # guess
  - { name: shooter, kind: flywheel, motor: kraken_x60, can_ids: [37], count: 3, ratio: 2.0 }  # 3 motors share id 37 today
  - { name: intake,  kind: linear,  motor: kraken_x60, can_ids: [33, 42], ratio: 3.75, m_per_rot: 0.0785, axis_down_deg: 8.54, max_travel_m: 0.30 }
  - { name: roller,  kind: flywheel, motor: kraken_x60, can_ids: [35, 36], ratio: 1.4 }
  - { name: feeder,  kind: flywheel, motor: kraken_x60, can_ids: [38], ratio: 2.0 }
  - { name: indexer, kind: flywheel, motor: kraken_x60, can_ids: [39, 41], ratio: 1.0 }
visuals: { model: advantagescope/Robot_OffSeason, info: model_info.json }
ball_path: { intake_capture: ..., stages: [hopper, indexer, feeder], shooter_exit: ... }
```

`??` and "guess" mean we do not have a measured value; the plan treats these as calibration knobs (section 11). Motor
types come from the CAD labels and need confirming.

## 9. Robot-side changes required

All in simulation only; the real robot path is untouched.

1. A `simbridge` package in the robot project (frame codec, device registry, handshake, heartbeat).
2. `*IOSim` classes use bridged devices instead of `TalonFXSim` (a small change; the IO split is already done).
3. **Swerve:** stop CTRE's internal `updateSimState` loop in Mode A; instead drive each module's drive and steer
   TalonFX sim states, CANcoder sim states and the Pigeon sim state from the app frame (spike S4 proves the odometry
   thread accepts this and measures the lag).
4. Driver Station and joystick state set from the app (`DriverStationSim`).
5. Digital inputs (beam breaks, limit switches) as sim inputs.
6. Mode B: Talon controller emulation inside `*IOSim`, a swerve sim layer replacing the CTRE drivetrain in sim, and
   clock control through `SimHooks`.
7. Known robot issues that interact with this (not part of the app): the three shooter motors currently share
   CAN ID 37, and the shooter gains cannot reach the target speed, so `readyToShoot()` is never true.

## 10. Milestones

Sizes are for a side project: S about a weekend, M one to two weeks of evenings, L three to five weeks, XL more.
Every milestone ends with something you can run.

| # | Milestone | Size | Done when |
|---|---|---|---|
| M0 | **Spikes (done, all GO, see [M0_RESULTS](spikes/M0_RESULTS.md))**: S1 NT4 round-trip and throughput from Electron; S2 minimal bridge on the hood in real time; S3 Rapier determinism and hundreds-of-balls performance; S4 CTRE swerve driven by externally set module, CANcoder and Pigeon states; S5 lockstep vs Talon (done) | M | A written go or no-go for each spike, with measurements, and `NT_CONTRACT.md` updated |
| M1 | **Viewer skeleton (done, see [app/README.md](../app/README.md))**: Electron app, NT4 client, 3D scene with your robot model, live view of existing topics (`Swerve/Pose`, `Mechanism3d/Components`), `.wpilog` playback and a basic plot panel | M | You can open a log of your robot and watch it live in the app |
| M2 | **Engine core with a test game (done, see [app/README.md](../app/README.md))**: fixed-step loop, Rapier world, plug-in host, `game-test`, ball spawning and bounce, scripted robot body, snapshots | L | Balls bounce deterministically in the app with a scripted kinematic robot |
| M3 | **Bridge + drivetrain authority (done, see [NT_CONTRACT.md](NT_CONTRACT.md) section 9)**: robot-side bridge, per-module swerve model, Driver Station and gamepad control, robot odometry matches physics truth | L | Drive the robot with a gamepad in the app; robot code's odometry agrees with the app |
| M4 | **Mechanisms under app authority (done, see [NT_CONTRACT.md](NT_CONTRACT.md) section 10)**: all Talon-driven mechanisms, robot definition loader, compared against today's `TalonFXSim` results | M | Turret, hood, intake, flywheels behave like the current sim at the same inputs |
| M5 | **Ball interaction (done, see [NT_CONTRACT.md](NT_CONTRACT.md) section 11)**: intake capture, stages and beam breaks, shooter launch with drag, spin and foam model, robot colliders vs balls | L | Intake a ball, see the beam break, feed it, shoot it, watch it fly |
| M6 | **Game module REBUILT + match flow + HUD (done, with assumptions listed in [the rules extract](../rules/REBUILT_RULES_EXTRACT.md) section 10; G403 and G407 included, TOWER not)**: rules extract, your review, implementation and tests | L | A full scripted match scores according to the reviewed rules |
| M7 | **Contact and pushing (done, see [NT_CONTRACT.md](NT_CONTRACT.md) section 13)**: robot-field and robot-robot contact tuning, BUMP climbing, contact feedback to the robot | M | Wall hits and pushing look and feel right; odometry reacts correctly |
| M8 | **Mode B**: Talon emulation and swerve sim layer in robot code, clock control, deterministic and faster-than-real-time runs | XL | Two identical scripted runs produce identical logs, at several times real time |
| M9 | **Scripted runs + analytics**: scripted driver input and autos, cycle times, accuracy, score-over-time reports | L | A batch of runs produces a report |
| M10 | **Multiple robots** | L | A second robot (scripted or a second robot process) shares the field |
| M11 | **Video and screenshot export** | S | Record a run to a file |
| M12 | **Calibration** when real data exists: shot table fit, drivetrain acceleration fit, validation plots | M | Sim reproduces a recorded real-robot shot table within an agreed tolerance |

Natural stopping points: after M1 (an AdvantageScope-style viewer for your robot), after M5 (balls and shooting), after
M6 (a scored game).

## 11. Calibration and validation without data

We have no measured data yet, so v1 is built to be tunable and honest about it:

- Every physical parameter is in the robot definition file, with a `source` note (measured, CAD-derived, guessed).
- Sanity anchors we do have: 4.39 m/s free speed at 12 V, motor and gearbox constants, the 120 A slip current,
  mechanism travel from CAD (intake 78.5 mm per rotation).
- Sanity checks the simulation must satisfy regardless of tuning: top speed, energy conservation in ball bounces,
  shot arcs vs a drag-free analytic arc at low speed, brownout behavior.
- When data arrives: fit the wheel friction and mass-related terms to an acceleration log, and the launch
  efficiency, spin gain and restitution curve to a shot table (distance vs hood angle vs flywheel speed).
- Mass, moment of inertia, center of gravity and wheel friction can be estimated from the CAD and the manufacturer's
  tire data in the meantime; I will flag each estimate in the definition file.

## 12. Testing

- **Engine unit tests:** pure TypeScript, no UI. Ball ballistics against analytic cases, mechanism step response
  against closed-form DC motor solutions, swerve straight-line and turning cases.
- **Determinism tests:** two runs with the same seed and inputs produce identical state hashes (Mode B and engine-only).
- **Contract tests:** a fake robot (a small script speaking the NT contract) exercises the app without Java.
- **Robot-side tests:** the bridge gets headless HAL tests like the ones you already use locally.
- **Golden runs:** recorded scripted matches whose scores and key events are asserted.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Talon sim vs lockstep (measured) | No faster-than-real-time with real Phoenix sim | Two-mode design; Mode B emulates controllers |
| CTRE swerve will not accept externally set module states, or its odometry thread lags | Full drivetrain authority is harder than planned | Resolved by S4: accepted with ~0 lag. Keep the CANcoder MagnetOffset rule in the bridge tests |
| NT latency or atomicity | Jittery or torn frames | Single packed frame per direction with sequence numbers. Measured (S1): NT floors at ~5 ms per round trip, fine for Mode A; Mode B uses a dedicated WebSocket channel |
| Physics fidelity without data | Wrong behavior that looks right | Knobs plus calibration milestone; sanity checks; clear labels on estimates |
| Rules accuracy | Wrong scoring | Researched extract, your review gate, tests mirroring the extract |
| Scope | Never finishing | Milestones with stopping points; each one usable |
| Rapier determinism or performance in WASM and Electron | Mode B or large ball counts fail | S3: the deterministic build is deterministic and snapshots restore exactly; 100 to 300 active balls fine, 600+ dense plow ~0.5 to 1x. Keep physics in a worker, budget active balls, sleep settled ones, ball step 2 to 4 ms |
| Foam deformation modeling cost | Time sink | Start with a speed-dependent restitution curve; visual squish last |
| Phoenix and WPILib version changes | Bridge breaks | Keep the bridge small and versioned; protocol version in the handshake |

## 14. Open questions

Resolved: app name and repo (Crucible, `Krotom/Crucible`), field geometry source (official documents, researched at
M6), multi-robot (scripted bots), gamepad mapping (`UniversalController` default), PathPlanner autos (they run inside
the robot code), app launches the robot sim (yes).

Still open:

1. Full current robot CAD (you will supply it); mass, bumper footprint and wheel type until then.
2. Should the sim truth also be logged through AdvantageKit on the robot side, or only in the app's own log?
3. Mode B: how much of the Talon emulation can be shared with the existing `TalonFXSim` code (decide at M8).
4. Ball-count budget per game: set when the REBUILT rules extract says how many fuel are on the field.

## 15. Prior art to review (not yet reviewed in this session)

I have not read these for this plan; each is a candidate to study before the milestone it informs, and any claim
about them above is from memory and needs checking.

- **maple-sim** (Java, in-robot-code physics with game-piece simulation): swerve force model, intake and projectile
  approaches (M3, M5).
- **MoSim**: the model for this app's direction.
- **AdvantageScope**: log and NT4 handling, 3D robot component conventions (M1).
- **Rapier docs**: CCD, determinism, collision groups (M0, M2).
- **WPILib HALSim and SimHooks, Phoenix 6 simulation docs**: bridge design and the Mode B limits (M0, M3, M8).

## 16. Proposed repository layout

Note from M1/M2: the app, the engine and the test game live together under `app/` (`app/src/engine`, `app/src/games`) as plain
folders with no UI imports in the engine. They can be split into the packages below once a second consumer exists (a
headless batch runner at M9 is the likely trigger).

```
Crucible/
  docs/                 PLAN.md, NT_CONTRACT.md, spikes/, rules/
  packages/
    engine/             game-agnostic physics and world (TypeScript, no UI)
    game-test/          tiny development game
    game-rebuilt/       the REBUILT plug-in
    nt/                 NT4 client and frame codec
    wpilog/             log reader
    app/                Electron main + renderer
  robot-bridge/         Java bridge library (consumed by the robot project; exact mechanism decided at M3)
  robots/offseason/     robot.yaml and model references
```

## Appendix A: robot data that already exists

Topics your robot publishes today (AdvantageKit logs and NT), useful for M1 and for comparison tests:
`Swerve/Pose`, `Swerve/SimTruthPose`, `Swerve/Speeds`, `Swerve/ModuleStates`, `Mechanism3d/Components`,
`Mechanism3d/CadPose`, `Mechanism3d/Zeroed`, `SuperStructure/State`, `SuperStructure/ReadyToShoot`, per-subsystem
inputs (`Hood/*`, `Turret/*`, `Shooter/*`, `Feeder/*`, `Indexer/*`, `Intake/Driver/*`, `Intake/Roller/*`),
`Vision/cam*Pose`. The exact NT prefix AdvantageKit uses is confirmed in M1.

3D assets: `advantagescope/Robot_OffSeason/` (body plus turret, hood and intake GLBs, `config.json`,
`model_info.json`), generated by `tools/split_robot_model.js` from the Onshape export.
