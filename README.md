# OffSeasonSim

A physics simulation app for FRC robot code: it receives motor outputs over NetworkTables, simulates the drivetrain,
mechanisms, game pieces and field (with game-specific scoring), and returns sensor values. Like AdvantageScope for
visualization plus a MoSim-style physics engine, built for testing real robot code.

Working title; status: **planning**. No code yet.

- [docs/PLAN.md](docs/PLAN.md): goals, decisions, architecture, physics model, milestones, risks, open questions
- [docs/NT_CONTRACT.md](docs/NT_CONTRACT.md): the robot-to-app NetworkTables contract (draft)
- [docs/spikes/](docs/spikes/): feasibility experiments and their measurements
- `docs/rules/`: the REBUILT rules extract (to be written, then reviewed before any rules are encoded)

The robot this is built around lives in the OffSeasonCode repository (swerve, turreted shooter, rack-and-pinion intake).
