# NT contract (protocol 0, implemented for the drivetrain in M3)

How the robot process and the app talk. Everything under `/SimBridge/<robot>/` belongs to this contract; `<robot>` is
`main` unless several robots are connected (milestone M10). Draft: the spikes (M0) will confirm or change numbers
here. Protocol version: **0**.

## 1. Principles

- The robot process hosts the NT4 server (localhost:5810); the app is a client. The app never needs to host.
- **Per-exchange data travels in one packed `raw` topic per direction**, never as many small topics. NT4 does not
  give an atomic snapshot across topics, and a physics step must see one consistent set of voltages or sensor values.
- Every frame carries a sequence number and the sender's simulation time.
- All numbers are little-endian float64 unless stated. Units: meters, radians or rotations as named, seconds, volts.
  Coordinates: WPILib field frame.
- A human-readable mirror of each frame is published at low rate (10 Hz) under `.../Debug/` as normal topics so the
  traffic can be inspected in AdvantageScope. The mirror is never read by either side.

## 2. Handshake and lifecycle

1. Robot publishes `/SimBridge/<robot>/Hello` (string, JSON): `{ "protocol": 0, "name": "...", "modes": ["realtime"],
   "exchangePeriodMs": 5, "devices": [ {"type":"talonfx","id":8,"bus":"rio"}, {"type":"cancoder","id":22},
   {"type":"pigeon2","id":1}, {"type":"dio","channel":0,"direction":"in"} ] }`. Device ids are CAN ids and must match
   the robot definition file; the app refuses to start on a mismatch and says which ids differ.
2. App publishes `/SimBridge/<robot>/Control/Hello` (string, JSON): `{ "protocol": 0, "mode": "realtime",
   "exchangePeriodMs": 5, "definitionHash": "..." }`.
3. Robot starts publishing ToApp frames once it has seen the app's Hello.
4. Robot publishes `/SimBridge/<robot>/Heartbeat` (int64, increments every 100 ms). The app pauses the world and shows
   "robot not responding" if the heartbeat stops for 1 s. The robot treats a missing FromApp frame for 1 s the same
   way (it holds the last values and raises a Driver Station warning).
5. Either side can restart; a new `Hello` resets sequence numbers.

## 3. Frames

### 3.1 ToApp frame (robot to app), topic `/SimBridge/<robot>/ToApp/Frame`, type `raw`

Header, then a variable body:

| Field | Type | Notes |
|---|---|---|
| magic | u32 | `0x31464253` ("SBF1") |
| protocol | u32 | 0 |
| seq | u64 | increments per frame |
| simTime | f64 | robot simulation time in seconds (WPILib FPGA time) |
| batteryVolts | f64 | the robot-side value (before the app's sag model) |
| nMotors | u16 | |
| flags | u16 | bit 0: robot enabled; bit 1: brownout |

Per motor (repeated `nMotors` times):

| Field | Type | Notes |
|---|---|---|
| id | i32 | CAN id |
| appliedVolts | f64 | the Talon sim's motor voltage (this is what the physics integrates) |
| flags | u32 | bit 0: brake neutral mode; bit 1: output is neutral (coasting or braking) |

Digital outputs are not needed yet.

### 3.2 FromApp frame (app to robot), topic `/SimBridge/<robot>/FromApp/Frame`, type `raw`

| Field | Type | Notes |
|---|---|---|
| magic | u32 | `0x32464253` ("SBF2") |
| protocol | u32 | 0 |
| seq | u64 | the ToApp `seq` this answers |
| simTime | f64 | the app's simulation time after the step |
| batteryVolts | f64 | after the sag model |
| nMotors, nCancoders, nPigeons, nDio | u16 each | |

Per motor: `id` (i32), `rotorPositionRot` (f64), `rotorVelocityRps` (f64), `rotorAccelRps2` (f64).
Per CANcoder: `id` (i32), `positionRot` (f64), `velocityRps` (f64), `absolutePositionRot` (f64).
Per Pigeon 2: `id` (i32), `yawDeg`, `pitchDeg`, `rollDeg`, `yawRateDps`, `pitchRateDps`, `rollRateDps` (f64 each),
`accelXg`, `accelYg`, `accelZg` (f64 each).
Per digital input: `channel` (i32), `value` (u8, padded to 4 bytes).

Rotor values are *rotor* side (before the Talon's `SensorToMechanismRatio`), because that is what the Phoenix sim
state expects.

### 3.3 Timing rules (Mode A, realtime)

- The robot publishes a ToApp frame every exchange period from its own notifier (5 ms by default).
- The app answers each frame as fast as it can. The robot applies the **latest** FromApp frame it has at the start
  of its next period; it never blocks. That gives one period of feedback delay, the same as `TalonFXSim` today.
- If the app is late the robot keeps applying the last frame and counts stale periods in a debug topic.
- The app uses `simTime` from the robot as the clock of record in Mode A and checks that it advances at about
  real-time speed.

## 4. Control topics (app to robot)

| Topic | Type | Contents |
|---|---|---|
| `Control/DS` | raw | enabled, autonomous, test, e-stop, alliance (red/blue), station, match time (f64), game-specific message (length-prefixed string) |
| `Control/Joystick/<n>` | raw | axes (up to 6, f64), button bitmask (u64, up to 64), POV array (i16 degrees, -1 = none) |
| `Control/Reset` | int64 | increments to ask the robot to reset its simulation state (pose seed, subsystems) |

The bridge applies these with `DriverStationSim` and updates once per exchange period. The WPILib sim GUI can still
drive the same state; the app shows which source is active.

## 5. App output topics (for AdvantageScope and robot logic)

Published by the app under `/SimWorld/`, not part of the control loop:

| Topic | Type | Notes |
|---|---|---|
| `Robot/Pose3d` | struct Pose3d | physics-truth pose |
| `Robot/BallsHeld` | int | virtual inventory size |
| `Balls/Poses` | struct Translation3d[] | outside-the-robot balls (subsampled when there are many) |
| `Game/Phase`, `Game/MatchTime` | string, double | from the game module |
| `Game/Score/Red`, `Game/Score/Blue` | int | |
| `Events` | string[] | shot, scored, captured, collision |

## 6. Mode B (lockstep) additions (milestone M8)

Not built first. **Transport change from M0:** NT cannot do a round trip faster than ~5 ms, so lockstep frames, `Step`
and `Ack` run on a dedicated local WebSocket (the Hello topic advertises its port; ~0.09 ms round trip measured, ~7.9k
exchanges per second). NT keeps the human-visible and AdvantageScope topics. The logical messages are the same as below:

| Topic | Direction | Notes |
|---|---|---|
| `Clock/Mode` | robot to app (in Hello) | `"realtime"` or `"lockstep"` |
| `Clock/Step` | app to robot, raw | `{ u64 seq, f64 dt }` |
| `Clock/Ack` | robot to app, int64 | the `seq` of the last completed step |

Sequence per step: the app sends `Step(seq, dt)`; the robot applies `FromApp(seq - 1)`, calls
`SimHooks.stepTiming(dt)` so every robot-code callback and notifier runs in simulated time, publishes `ToApp(seq)`,
then sets `Ack = seq`; the app reads `ToApp(seq)`, steps the physics by `dt`, publishes `FromApp(seq)` and sends the
next `Step`. In this mode all Talon control uses the Java emulation, not the Phoenix sim (see PLAN.md section 3).

## 7. What the spikes decided (see spikes/M0_RESULTS.md)

- **S1:** NT4 delivers server-to-client updates no faster than about 5 ms, so an NT round trip floors near 5 ms.
  A 5 ms exchange period is fine for Mode A. `raw` frames of a few hundred bytes work. Large binary messages can
  arrive fragmented (the Java WebSocket client splits them): reassemble before parsing. Faster-than-real-time needs
  the side channel in section 6.
- **S2:** applying `setRawRotorPosition` and friends from an app frame reproduces today's `TalonFXSim` behavior
  (hood step response 0.62 s vs 0.59 s). Set the sim state's motor type to match the real device and the
  `Orientation` for inverted mechanisms.
- **S4:** the CTRE swerve accepts externally set drive/steer rotor states, CANcoder positions and Pigeon yaw with
  essentially zero lag. **CANcoder rule:** the app sends the *reported* azimuth; the bridge sets
  `raw = azimuth - MagnetOffset`, because the device reports `raw + MagnetOffset`. Drive sim states of inverted
  (right-side) modules use `Orientation = Clockwise_Positive`.
- Open: choice between `raw` and a WPILib `struct` array if AdvantageScope-visible frames turn out to be worth the
  overhead.

## 8. Versioning

`protocol` is an integer in the handshake and in every frame header. Bump it on any layout change; the app refuses
to run against a mismatched robot and names both versions.

## 9. What M3 implemented, exact layouts and conventions found

Robot side: `frc/robot/lib/simbridge/` in the robot project (`FrameCodec`, `SimBridge`), switched on by the environment
variable `CRUCIBLE_BRIDGE=1` (the app sets it when it launches the robot; off otherwise, so the normal sim is unchanged).
App side: `app/src/engine/bridge/` (`frames.ts`, `nt4raw.ts`, `session.ts`) and `app/src/engine/drivetrain.ts`.
`docs/bridge/FrameCodecTest.java.txt` checks the Java codec against bytes produced by the TypeScript codec.

**Implemented:** Hello (string JSON, republished once), Heartbeat, `Debug/StaleTicks`, ToApp and FromApp frames as in section 3
(sizes: ToApp 36 + 16 per motor; FromApp 40 + 28 per motor + 28 per CANcoder + 76 per Pigeon + 8 per digital input),
`Control/DS`, `Control/Joystick/0`, `Control/PoseSeed`. **Not yet:** `Control/Hello` (the robot publishes frames from the start),
digital inputs, the battery sag model, neutral-mode flags, Mode B. Devices bridged today: the eight swerve Talons, four
CANcoders and the Pigeon.

| Topic (raw) | Layout, little-endian |
|---|---|
| `Control/DS` (24 bytes) | u64 counter, u32 flags (1 enabled, 2 autonomous, 4 test, 8 estop, 16 DS attached), u8 alliance (0 red, 1 blue), u8 station, u16 pad, f64 match time |
| `Control/Joystick/0` (72 bytes) | u64 counter, 6 x f64 axes (WPILib Xbox order: LX, LY, LT, RT, RX, RY), u64 button mask (bit 0 = button 1), i16 POV degrees (-1 none), 6 bytes pad |
| `Control/PoseSeed` (32 bytes) | u64 counter, f64 x, f64 y, f64 yaw rad: the robot resets its odometry pose when the counter changes |

The robot applies a control topic only when its counter changes. The app holds the pose seed back about 20 frames after a
reset or connect so the robot has seen the new wheel positions first (otherwise the jump in wheel distance is integrated as motion).

**Timing as built:** the robot's clock drives the world. Each ToApp frame carries the robot's simulation time; the app steps
the engine by the elapsed robot time (capped at 0.25 s per frame, counted in `skipped`) with that frame's voltages held,
then answers with the same `seq`. The robot applies the latest FromApp frame at each 5 ms tick. Pause means the app keeps
answering without stepping.

**Conventions the spikes and M3 established (keep them in any new bridge code):**

- *Voltage sign.* Set `TalonFXSimState.Orientation` from the module constants (drive: `DriveMotorInverted`, steer: `SteerMotorInverted`,
  encoder: `EncoderInverted`) exactly as CTRE's own swerve sim does. Then positive drive volts mean the module's forward and positive steer
  volts mean counterclockwise azimuth, whatever the inversion, and the rotor values the app returns use the same sense.
- *Applied voltage includes current limiting.* The Talon sim's `getMotorVoltage()` already reflects the stator current limit: while a fast
  wheel is braked it reports about back-EMF minus R times the limit. The app therefore applies its own DC model (back-EMF from the rotor
  speed it integrates) to that voltage and never subtracts back-EMF twice.
- *CANcoder.* The device reports raw + MagnetOffset, so the bridge sets raw = azimuth - MagnetOffset; the app sends the reported azimuth.
- *Coupling.* The drive rotor position the app returns includes coupling ratio times azimuth rotations (CTRE odometry subtracts it).
- *Pigeon.* Yaw in degrees, continuous (not wrapped); the robot's odometry seed sets the heading offset.
- *Sim GUI off.* With the bridge on, the WPILib sim GUI is disabled (`build.gradle` keys it on `CRUCIBLE_BRIDGE`) because its driver
  station window overwrites joystick data every frame. The app is the driver station.
- *Hidden windows.* Input is pumped from `requestAnimationFrame`, so a hidden or minimized window sends no new joystick state.

**Measured in M3 (open floor, robot odometry vs the app's physics):** straight 2.2 m, rotation of 4.2 rad and a 2.2 m strafe agree within
about 1 cm and 0.005 rad. Pushing against a wall with the wheels spinning makes odometry drift, as on a real robot.

## 10. M4: the transport changed to a WebSocket, mechanisms, and the robot definition

**Transport (supersedes the NT topics of sections 3 and 4 for everything per-exchange).** Frames and controls travel on a local
WebSocket served by the robot process, `ws://127.0.0.1:5811` (`frc/robot/lib/simbridge/WsServer.java`; the app is the client).
Every message is one type byte followed by the frame whose layout is unchanged from sections 3 and 9:

| Type | Direction | Body |
|---|---|---|
| 1 | robot to app | ToApp frame |
| 2 | app to robot | FromApp frame (same `seq` as the ToApp it answers) |
| 3, 4, 5 | app to robot | DS, Joystick 0, PoseSeed (layouts in section 9) |
| 6 | robot to app | Hello, UTF-8 JSON (sent on connect and whenever the device list changes) |
| 7 | robot to app | stats every 100 ms: f64 average round trip (us), f64 maximum round trip (us), i64 stale ticks |

Why: NetworkTables batches updates, so a real round trip measured 14 to 23 ms on the robot sim (M0's idle test said ~5 ms), and
the Talons' high-gain loops (intake driver, hood) rang. The WebSocket measures 1 to 2 ms. The robot applies each FromApp the moment
it arrives, not at the next 5 ms tick. NT still carries Hello, Heartbeat and `Debug/StaleTicks` / `Debug/RttAvgUs` for
AdvantageScope, and the app reads the robot's own `Mechanism3d/Components` from NT to draw the model.

**Latency compensation.** The robot times every ToApp frame against its answer (the round trip). The app reports each *mechanism*
that far ahead of its physics clock, assuming the voltage stays as it is (a throwaway projection; the world is not rolled back), so
the Talon control loops feel about a real robot's delay instead of the exchange's. Only mechanisms are projected; the drivetrain is
reported as it is. With 1.3 ms of lead the intake settles exactly as in the old sim; with no lead it rings.

**Mechanisms.** `TalonFXSim` registers its lead motor with the bridge when `CRUCIBLE_BRIDGE=1` (no DCMotorSim, no local thread). The
Hello message carries, per mechanism, `{id, motor, count, ratio, inertia}`; the app checks them against its robot definition
(`app/robots/offseason/robot.yaml`) and lists every difference in the readout (ids the robot has that the definition cannot move,
ids the definition expects, different motor, count or gear ratio). ToApp motor flag bit 2 means the robot code re-zeroed that
motor's position: the app zeroes the mechanism's physics on the rising edge (the flag is held for 4 frames).

**Motor model facts (from comparing with the robot's current physics):** n motors on one shaft are one motor with the resistance
divided by n and the same torque and back-EMF constants; WPILib's Kv includes the motor's free current, so the constants are taken
as WPILib builds them (`DCMotor.getKrakenX60/X44`). With these, all seven mechanisms follow WPILib's DCMotorSim to 1e-6 over a
reversing voltage profile (`app/tests/mechanism.test.ts`, fixture generated by `MechanismReferenceGenerator.java`).

**Measured on the real robot sim through the app (state cycle idle, intaking, idle, shooting, idle):** intake driver 3.00 rot idle
and 10.00 rot intaking (same as the old sim), roller 17.9 rps (17.95 before), hood 3.000 rot shooting and 0 idle, turret follows its
target, intake shake range about 0.3 to 3.0 rot (0.97 to 2.96 before).

## 11. M5: ball interaction (app side only)

The hybrid ball model lives in the app (`app/src/engine/balls.ts`, configured by `ballHandling` in `robots/offseason/robot.yaml`). It reads the
mechanism states the robot code produced (intake driver position, roller, indexer, feeder, flywheel, turret, hood) and needs nothing new on
the wire.

- **Capture:** an oriented box that slides with the intake driver (0.0785 m per rotation, 0.293 m of travel along the slide). A piece is
  caught when the intake is at least 80% out, the roller runs at 5 rps or more in the pulling direction, the piece is slower than 4 m/s
  relative to the robot and there is room at the mouth (one piece per spacing). The body is removed and becomes a queue entry.
- **Stages:** entries ride at the surface speed of the stage they are in (intake roller, indexer, feeder; the code runs the indexer negative to feed,
  so its direction is -1). They stop behind each other and at the end of a stage whose roller is idle. Beam breaks are true while an entry is
  within one ball radius of their position.
- **Launch:** the front entry leaves when it is at the end of the path, the last stage pushes at 0.5 m/s or more and the flywheel turns at
  5 rps or more. Speed = efficiency x 2 pi x wheel radius x flywheel rps; heading = robot yaw + turret angle; elevation = 80 deg - hood rotations x 10 deg;
  the piece inherits the robot's velocity and leaves with backspin (spin parameter 0.2).
- **Flight:** quadratic drag, Magnus lift (C_L = min(0.4, 1.2 x spin parameter)) and foam restitution that falls with impact speed.
- **Events:** `piece-captured` and `piece-launched` reach the game module. **Not wired:** beam breaks are not returned to the robot as digital
  inputs, because the robot code reads none yet; they are in the readout and in the `/Sim/Beam*` topics.
- **All of the numbers are guesses** (stage lengths, roller radii, efficiency, exit elevation, backspin) until the CAD is measured and a shot table
  exists (M12).

**Stage order** (from the team, not confirmed): intake -> revolver/spindexer (the indexer motor) -> feeder -> turret -> shooter. A stage moves at the summed
surface speed of its drivers; the first stage is moved by the intake roller while intaking and by the indexer while shooting. The CAD's revolver is a drum with
its own reduction, which this straight queue only approximates. The robot has no beam-break sensor on `main` or `protonme` (the CAD has no sensor parts either);
the teammate branch `origin/Burak` reads a `DigitalInput(0)` at the shooter exit, active low, to count shots, so DIO 0 is the natural channel for the exit beam if that branch is merged.

**Measured with the real robot code through the app** (test game, robot near (2.6, 2.6)): three balls caught while driving and queued, then, with the shooter at
speed, all three launched in sequence (the first scored 3 in the hub in one run; shots are uncalibrated guesses, so they do not all land). This needed two fixes in the
robot code, now committed on `protonme`: shooter kV 0.119 -> 0.24 and kP 0.01 -> 0.2 (the flywheel stalled near 30 rps against a 43-50 rps target, so the shooter was never
ready), and a debounced feeder jam check (the 40 A threshold tripped on the startup current of every feed command, so the feeder reversed every time).

## 12. M6: the app as the field system (REBUILT)

- **Control/DS (type 3)** now carries the **Game Data** character at byte 14 (it was padding): `'R'` or `'B'`, the alliance whose HUB goes inactive first; 0 means none sent.
  The robot applies it with `DriverStationSim.setGameSpecificMessage`, so `DriverStation.getGameSpecificMessage()` returns it (verified on the real robot sim).
- **Match control.** "Start match" resets the engine and starts the field system: the app enables and disables the robot from the match phases (enabled in AUTO and
  TELEOP, disabled in the 3 s between and after the match), sets autonomous in AUTO, sends the match time (AUTO counts 20 to 0, TELEOP 140 to 0) and the Game Data
  about 3 s after AUTO ends (at the start of the TRANSITION SHIFT). The Enable button is for practice; "End match" hands control back.
- **Timing caveat.** The match clock is the engine's (robot time elapsed), so it runs in real time with the robot; pause stops it.

## 13. M7: contact, pushing and the floor (app side; the wire format did not change)

- **Chassis body.** A chamfered convex footprint (radius `chassis.chamfer`, 4 cm) with explicit mass (`chassis.mass`) and yaw inertia (`chassis.moi`). Bumper friction 0.45 and restitution 0.25
  (guesses). Rapier combines per pair: bumper on field surface multiplies (0.45 x the wall's 0.8 = 0.36), bumper on bumper averages (0.45).
- **Other robots** (`RobotSpec.others`): dynamic planar bodies. Each step the force and torque that cancel the error to their script velocity (zero without a script) are applied, limited to
  `mu * m * g` (torque: that force at 0.4 of the half diagonal). That makes them brake like Coulomb friction (they hold against a push up to the limit and slide above it) and accelerate at the traction limit.
  Measured in the tests: a 52 kg robot (612 N of traction) shoves a 55 kg robot with mu 0.5, and cannot move one with mu 1.6.
- **Terrain.** `GameModule.terrain(x, y)` is the floor height. A plane is fitted through the heights under the four modules: its height at the body origin is the robot's z, its slopes are the Pigeon's
  pitch (right-hand rule about the left axis, so nose up is negative) and roll (about the forward axis, left up positive), and `-m g grad h` acts on the chassis. The frame carries the tilted pose
  (`robot` = x, y, z, qw, qx, qy, qz); REBUILT's BUMPS are the only terrain (a ridge 1.128 m deep, 1.854 m wide, 0.165 m high with linear ramps). The ridge is narrower than the wheelbase, so the
  plane averages its peak (the body rises to about half the ridge height). Tire normal load does not change with the tilt and the body stays planar for physics.
- **Contact feedback.** The engine compares the chassis acceleration with what the tires and the slope produce; the rest is contact. When a contact has been quiet for 50 ms it becomes one
  `robot-impact` event (`against`: `field` or `robot`, and the speed change, rebound included), shown as `hits` in the readout. Impacts and other robots enter the state hash only when they exist, so the
  recorded hash of the test game did not change.
- **Pigeon.** Pitch, roll and their rates reach the robot (it already applied them). The accelerometer values (`accelXg/Yg/Zg`, including the gravity projection on a slope and impact spikes, 8 g limit) are
  in the frame, but `Pigeon2SimState` (Phoenix 6 26.3) has no acceleration setters, so the robot code never sees them.
- **Not done:** robot against robot with the second robot driven by robot code (M10); tire load shifts on a slope; a measured bumper friction and restitution (M12).

## 14. M8: Mode B (lockstep), as built

- **Switch:** the robot starts with `CRUCIBLE_BRIDGE=1` and `CRUCIBLE_MODE=lockstep` (the app's launcher does this); its Hello message lists `"modes":["lockstep"]`, and the app flags a robot that says anything else.
- **Messages (same WebSocket):** type 8 **Step**, app to robot: u64 seq, f64 dt. Everything else is as in Mode A. Sequence: the app sends the seed and `FromApp(0)` (the state the robot starts from), then `Step(1)`. On a Step the robot
  runs `SimHooks.stepTiming(dt)` (every notifier, the robot loop and the subsystems run in simulated time inside it), lets the swerve layer turn the standing request into module targets, lets every `EmuTalon` compute its voltage from the newest
  request and the rotor state the app last returned, and answers `ToApp(seq)`. The app applies those voltages, steps the physics for dt, answers `FromApp(seq)`, and sends the next Step. `ToApp(seq)` is the Ack.
  Driver Station, joystick and pose-seed messages are sent between exchanges, so they land at a known step; a script ties them to sim time with `session.at(t, fn)` (run before the Step that crosses t).
- **Start-up barrier.** The robot loop's alarms are set from the paused time, so their phase against the steps is the same every run as long as no step comes before the loop's first iteration: the first Step waits for `Robot.simulationInit`
  and the first `robotPeriodic`, plus 0.3 s of wall time. (Without it, two runs differed from the first step.)
- **EmuTalon** (`lib/simbridge/EmuTalon.java`): VoltageOut with the open-loop voltage ramp, MotionMagic position and velocity profiles (trapezoid, or an acceleration ramp with jerk), PositionVoltage and VelocityVoltage, Slot0 kS (by the sign of the reference
  velocity, or of the error), kV, kA, kP, kI, kD, continuous wrap for steering, the stator current limit as a window on the voltage (current = (V - back-EMF) / R), the supply voltage, and **neutral while the robot is disabled**. A profile limit that is 0 or infinite is
  replaced by one from the motor's free speed, as `TalonFXSim` does, so both modes agree. The seven mechanism IOs have emulated twins (`EmuIOs`) built from the robot's own config classes and chosen where the Phoenix-sim IOs are (`SimBridge.isLockstep()`).
  Not modeled: brake against coast (0 V is the shorted winding in both), soft limits, supply current limits, differential control, Pro features.
- **EmuSwerve** (`lib/simbridge/EmuSwerve.java`): turns FieldCentric, RobotCentric, ApplyRobotSpeeds (PathPlanner) and SwerveDriveBrake requests into module states the way the CTRE module does (operator perspective, deadbands, discretize, optimize, cosine
  scale, wheel-speed desaturation, the coupled azimuth rate backed out of the drive velocity, open-loop volts = speed / speedAt12Volts x 12), drives the module `EmuTalon`s with TunerConstants' gains, and runs a WPILib pose estimator (wheel positions, Pigeon yaw, vision
  with timestamps) once per exchange. `SwerveDrivetrain.getState()` is final, so the robot code reads `CommandSwerveDrivetrain.state()` (the emulation in lockstep, CTRE's otherwise). **Vision is off in lockstep** (`VisionSubsystem.periodic` returns): the PhotonVision sim
  draws random noise and reaches the cameras through NetworkTables on the wall clock.
- **Measured with the real robot project** (test game, the robot driving a script of forward, strafe and stop for 6 s): two runs gave the same engine state hash at every 0.5 s sample, at 3.5 to 4.2x real time with a 5 ms exchange and physics step
  (1 ms: 1.1 to 1.6x; 2 ms: 2.5x). The 5 ms run ends within 2 cm of the 1 ms run. The cost is about 0.4 to 0.6 ms of robot side and 0.17 ms of physics per simulated millisecond.
- **Compared with the Phoenix sim (Mode A)** on the intake: the slide (MotionMagic position, 3 to 10 rot) reaches 50% at 0.33 s and 90% at 0.50 s (A) against 0.51 s (B) after the press, the curves within 0.13 rot; the roller (voltage with a 0.3 s ramp) starts about 0.1 s later in A
  (90% at 1.05 s against 0.96 s), which is the real-time loop's extra latency. Not compared: the shooter velocity loop, the turret and hood, the swerve steer loop against CTRE's.
- **Known gaps:** `ClosedLoopError` is the profile reference minus the measurement (my reading of Phoenix; not checked); the robot accepts one app at a time (a stray Crucible window on port 5811 steals the connection); only the drive script has been shown repeatable (shooting and ball
  handling are not yet); the UI buttons are wall-clock timed.

