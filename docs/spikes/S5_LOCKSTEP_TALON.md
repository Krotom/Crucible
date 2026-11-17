# Spike S5: does the Talon FX sim follow WPILib's stepped clock?

Date: 2026-11-17. Status: done. Answer: **no**, not usefully.

## Question

Lockstep (pause the robot sim and step it explicitly, faster than real time) needs every part of the robot sim to
follow WPILib's simulated clock. WPILib provides `SimHooks.pauseTiming()` and `SimHooks.stepTiming(seconds)`. Does the
Phoenix 6 Talon FX simulation, the part that runs MotionMagic and the other closed-loop controllers, follow them?

## Method

Test source: [S5_LockstepSpikeTest.java.txt](S5_LockstepSpikeTest.java.txt) (a throwaway JUnit test in the robot
project's local sim tests; renamed so it does not compile here).

1. Build the robot's hood IO on a simulated Talon FX with its real gains and MotionMagic profile, with DCMotorSim
   physics stepped by a WPILib `Notifier` (the robot's `TalonFXSim`) on the FPGA clock.
2. Reference: command a 0 to 2.0 rotation move in plain real time; it reaches 2.0 in 0.59 s.
3. Repeat the same move with `SimHooks.pauseTiming()` and a loop of `SimHooks.stepTiming(0.005)`, calling
   `Unmanaged.feedEnable(100)` each step, with a busy-wait of N microseconds of wall time after each step.

## Results

| Wall wait per 5 ms step | Speed vs real time | Final position (target 2.000) | Reached target at (sim time) |
|---|---|---|---|
| real-time reference | 1x | 2.000 | 0.59 s |
| 5000 us | 1.0x | 2.000 | 0.62 s |
| 2500 us | 1.9x | 2.000 | 0.97 s |
| 1000 us | 4.6x | 2.001 | 2.01 s |
| 500 us | 8.7x | 2.082 | 3.73 s |
| 0 | 79x | 0.172 | never |

## Interpretation

- The WPILib-side physics (a `Notifier` using the FPGA clock) follows stepped time exactly.
- The Talon control loop runs on its own native thread against the wall clock. Stepping the sim clock faster than
  real time gives it fewer control iterations per simulated second, which slows and distorts the response; at
  zero wall time per step it barely runs at all.
- Pure lockstep with the real Phoenix sim is therefore only valid at about real-time speed (and then is not
  deterministic, because the thread timing is wall-clock).

## Consequence for the plan

Two timing modes: Mode A (real-time, real Phoenix sim, built first) and Mode B (deterministic lockstep and
faster-than-real-time with Java-emulated Talon controllers and a sim drivetrain layer, a later milestone). See
`PLAN.md` section 3.

## Not tested here

- The CTRE swerve drivetrain's own odometry thread (very likely the same wall-clock behavior): spike S4.
- Behavior with the real robot's current limits under load; the Mode B emulation will need its own current-limit model.
