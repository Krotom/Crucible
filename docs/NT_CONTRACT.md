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

**Measured with the real robot code through the app** (test game, robot at (2.65, 2.66)): three balls caught while driving, the indexer queued them,
and with the shooter at speed one shot left 0.75 s after the shoot command, peaked at 1.9 m and came down in the hub volume (+3 points). This needed two
changes to the robot's constants that are not committed: the shooter gains (kV 0.119 would hold the flywheel near 30 rps, short of the 43-50 rps the shot
table asks for; kV 0.24 and kP 0.2 reached 44 rps) and the feeder jam threshold (40 A trips on the startup current of a 7 V command, so the feeder
reverses every time; 400 A let it run). Without them the shooter never becomes ready and the feeder never feeds.
