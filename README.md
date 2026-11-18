# BALTA Crucible

A physics simulation and analysis app for FRC robot code, built by BALTA Robotics (the repository and folder keep the name Crucible). It runs your real robot program against a simulation of the robot, the REBUILT field and the game pieces: the app is the physics authority, the robot code keeps its own control loops and gets motor, encoder and gyro values back. Think AdvantageScope for visualisation plus a MoSim-style physics engine, built for testing real robot code. It is also a log viewer (live NetworkTables 4 or `.wpilog`) with a 3D view and plots.

The robot it is built around lives in the OffSeasonCode repository (swerve, turreted shooter, rack-and-pinion intake).

## Get it

Download the installer or archive for your system from the **Releases** page (Windows `.exe`, Linux `.tar.gz`, macOS `.zip` for Apple silicon and Intel). Releases are made automatically when the version in `app/package.json` changes on `main`, and the app updates itself from them: it tells you at start when a newer version exists, and **About > Check for updates > Install the update** does the rest. The first-run notes for each system (SmartScreen, Gatekeeper, the Linux sandbox) are in [app/README.md](app/README.md#install); how releases and updates work is in [docs/RELEASING.md](docs/RELEASING.md).

From source: `cd app && npm install && npm run dev` (or `npm run app`).

## Status

The plan's milestones M0 to M13 and every item of the feature list ([docs/IDEAS.md](docs/IDEAS.md)) are done and tested: viewer, deterministic engine, robot-code-in-the-loop (real time and deterministic lockstep, faster than real time), all mechanisms, balls and shooting, the REBUILT game module with match control, contact and BUMPS, scripted runs and bots, analysis (match summary, shot map, attempts, comparison, sweeps), tuning and calibration, robot testing tools (battery, faults, scenarios, vision), quality-of-life features (command palette, presets, Turkish interface, accessibility), team features (sharing, strategy board, local API, game plugins), CI, automated releases for Windows, Linux and macOS, and self-update.

What it does **not** yet do, plainly:

- **The physics is not validated against the real robot.** Mass, friction, ball drag and spin are estimates (tagged `GUESS` in `app/robots/offseason/robot.yaml`); the calibration tools exist but no real measurements have been fitted. Treat it as a tool for logic, relative comparisons and bug-hunting until you have fitted and checked it on your own shots ([app/README.md](app/README.md#trusting-the-numbers)).
- **Vision:** the simulated AprilTag camera sends its data, but the robot library does not read it yet.
- **TOWER scoring** is not in the REBUILT module ([rules extract](rules/REBUILT_RULES_EXTRACT.md) lists what is implemented and assumed).
- **Windows and macOS packaging and self-update** are written but have only been exercised on Linux.

## Documents

- [app/README.md](app/README.md): installing, using every tab, shortcuts, the engine, limits
- [docs/PLAN.md](docs/PLAN.md): goals, decisions, architecture, physics model, milestones, risks
- [docs/NT_CONTRACT.md](docs/NT_CONTRACT.md): the robot-to-app bridge contract (frames, WebSocket messages, lockstep, vision)
- [docs/ROBOT_INTEGRATION.md](docs/ROBOT_INTEGRATION.md): adding the bridge library to a robot project
- [docs/TESTING.md](docs/TESTING.md): unit tests, UI tests, CI
- [docs/RELEASING.md](docs/RELEASING.md): packaging, releases, signing, self-update
- [docs/IDEAS.md](docs/IDEAS.md): the feature checklist
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): measurements with a big FUEL pile
- [docs/spikes/](docs/spikes/): the feasibility experiments and their measurements
- [rules/REBUILT_RULES_EXTRACT.md](rules/REBUILT_RULES_EXTRACT.md): the REBUILT rules the game module implements and assumes
- `robot-lib/`: the Java library that goes into the robot project (simulation only)
