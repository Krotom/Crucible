# NT contract (draft v0)

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
