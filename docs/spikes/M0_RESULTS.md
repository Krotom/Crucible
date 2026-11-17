# M0 results: feasibility spikes

Date: 2026-11-17. Machine: the development PC (Windows 11). Robot: OffSeasonCode (WPILib 2026, Phoenix 6 26.3.0).
Every spike has a go or no-go. Sources are archived next to this file or in `spikes/`.

| Spike | Question | Verdict |
|---|---|---|
| S5 | Can the robot run in lockstep with the real Phoenix sim? | **Only at ~1x real time** (see [S5_LOCKSTEP_TALON.md](S5_LOCKSTEP_TALON.md)). Two-mode design stands. |
| S1 | Can an external app exchange packed frames with the robot over NT4 fast enough? | **GO for Mode A** (5 ms period). **NO-GO for Mode B over NT**: needs a side channel. |
| S1b | What can the machine do without NT? | Plain WebSocket: ~0.09 ms round trip, ~7.9k exchanges/s. |
| S2 | Does the app-closed loop reproduce `TalonFXSim` behavior (hood)? | **GO.** |
| S3 | Is Rapier deterministic, snapshot-able and fast enough for the balls? | **GO**, with a ball-count budget. |
| S4 | Does CTRE swerve accept externally supplied module, CANcoder and Pigeon states? | **GO**, essentially zero added lag. |

## S1 / S1b: NT4 round trip

Setup: a Node "app" (`spikes/s1s2-app.js`, minimal NT4 client in `spikes/nt4.js`) against the robot process running the
bridge test (`S1_S2_BridgeSpikeTest.java.txt`). The robot publishes a ToApp `raw` frame, the app answers with a
FromApp frame echoing the sequence number.

- NT4 server-to-client updates cannot be delivered faster than about **5 ms** per hop, so an NT round trip floors
  near 5 ms regardless of how fast either side is. A 5 ms exchange period is the practical limit; it is fine for
  Mode A because the Talon loops stay in the robot.
- Control: a plain WebSocket echo (`spikes/s1b-ws-echo.js`) between the same Java client and Node server gives
  ~0.09 ms round trip and ~7.9k exchanges/s. So the limit is NT's update batching, not the machine or Java.
- **Consequence for Mode B (lockstep, faster than real time):** it cannot ride NT. Add a dedicated local WebSocket
  channel for `Step`/`Ack`/frames (NT stays for the human-visible topics and AdvantageScope).
- Two bugs found and fixed in the spike, both relevant to the real bridge:
  1. Java's `HttpClient` WebSocket **fragments** large binary messages; `onBinary(last=false)` fragments must be
     reassembled, and sends should be awaited (`sendBinary(...).join()`).
  2. A busy-wait on a plain array was hoisted by the JIT and never saw updates; use atomics or volatile state for
     anything shared between the WebSocket thread and the control thread.

## S2: hood through the app

The hood's `HoodIO` was driven from the app: the robot sends applied volts, the app integrates an exact-discretized DC
motor model (`a = -(G^2 Kt)/(Kv R J)`, `b = G Kt/(R J)`) and returns rotor position and velocity, the bridge applies
them with `setRawRotorPosition`/`setRotorVelocity`.

- Closed loop to the target: **0.62 s** with the app in the loop vs **0.59 s** with today's `TalonFXSim`. GO.
- Needs `setMotorType(KrakenX44)` on the sim state (an X60/X44 mismatch earlier produced the hood runaway) and
  `Orientation = Clockwise_Positive` for inverted mechanisms, as noted in the contract.

## S3: Rapier

`@dimforge/rapier3d-deterministic-compat@0.21.0` in Node (`spikes/s3-rapier.js`, `spikes/s3b-steady.js`).

- **Determinism:** same-process runs hash identically; snapshot then restore then continue matches the straight run
  bit for bit; cross-process hashes were compared as well. The deterministic build is required (the plain build is not
  guaranteed across machines).
- **Performance** (1 ms steps, 0.15 m balls): 100 to 300 active balls are comfortably real time. A dense plow through
  600+ balls with a kinematic robot drops to roughly 0.5 to 1x real time at a 1 ms step. Levers that help:
  sleeping (settled balls sleep), a 2 to 4 ms ball step with the robot substepped separately, and fewer solver
  iterations (`ITER` env in `s3b-steady.js`).
- **Budget:** keep rigid balls to a few hundred active at once; the game plug-in declares its count, and far-away
  or settled balls are put to sleep or collapsed to cheap kinematic markers.

## S4: CTRE swerve with external state

Test: `S4_SwerveSpikeTest.java.txt`. The drivetrain's modules, CANcoders and Pigeon are fed from a stand-in physics
model instead of the Phoenix sim.

- Drive rotor position and velocity, steer rotor position, CANcoder raw position and Pigeon yaw/rate can all be set
  externally and the stock `SwerveDrivetrain` odometry follows them.
- Driving at 1 m/s the odometry trailed truth by **0.000 m on average (0 ms of lag)**; final x 3.507 vs truth 3.505,
  y 0.000; odometry thread ran at about **250 Hz**; heading tracked the Pigeon.
- **CANcoder rule:** the CANcoder reports `raw + MagnetOffset`, so the app sends the *reported* azimuth and the bridge
  sets `raw = azimuth - MagnetOffset`. Getting this wrong made the odometry run in the wrong direction.
- Right-side modules with inverted drive need the drive sim state's Orientation set to Clockwise_Positive.

## Decisions that change the plan

1. Mode A uses NT for the frame exchange (5 ms period, one frame of feedback delay, same as today).
2. Mode B gets a **dedicated WebSocket side channel** for lockstep frames (new, see NT_CONTRACT section 6).
3. Ball count budget and the 2 to 4 ms ball step are design constraints for M2/M5.
4. Full drivetrain authority is feasible with the stock CTRE swerve classes (no custom odometry needed).
