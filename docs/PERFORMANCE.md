# Performance with a big FUEL pile

The manual has about 408 FUEL in the neutral zone (504 per match). This is what we measured, what we changed, and what we found out about other simulators.

## Measured (this engine, one thread, the robot plowing straight through the whole neutral pile at 6 V)

Benchmark: `CRUCIBLE_BENCH=1 npx vitest run tests/bench.test.ts` (cases in `tests/bench.test.ts`, result in `runs/bench.txt`). "x real time" is simulated seconds per wall second.

| setup | ms per step | x real time |
|---|---|---|
| 150 FUEL, 1 ms step | 0.25 | 4.0 |
| 408 FUEL, 1 ms step (the old setup) | 1.20 | 0.83 |
| 408 FUEL, 2 ms | 1.31 | 1.5 |
| 408 FUEL, 5 ms | 1.37 | 3.7 |
| 408 FUEL, 2 ms, pile freezing + CCD on fast pieces only | 1.21 to 1.26 | 1.6 |
| 408 FUEL, 3 ms, pile freezing + CCD fast | 1.37 | 2.2 |
| 408 FUEL, 5 ms, pile freezing + CCD fast | 1.20 | 4.2 |

What the numbers say:

- **The step size is the lever.** Cost per step hardly changes with the step (1.2 to 1.4 ms), so a 5 ms step does five times as much simulated time per second of work as 1 ms.
- **A resting pile is cheap already** (Rapier sleeps it: all 456 pieces asleep cost about 0.16 s per simulated second, mostly the robot and mechanisms), but the pile is one touching island: the moment the robot touches it, all 408 FUEL wake (measured 1.3 to 1.8 s of work per simulated second) and it takes about 5 s to fall asleep again.
- **What did not help** (1 ms, 408 FUEL): CCD off (0.77x, no gain), soft CCD (0.53x, worse), one solver iteration (0.70x), one internal PGS iteration (0.78x). Letting only fast pieces use CCD is neutral to slightly positive.
- **What helped a little:** pile freezing (below): the far part of the pile never wakes and the pile settles faster. When the robot bulldozes the whole pile, most FUEL really move, and the saving is about 20%.

## What changed in the app

- Default physics step is **2 ms** (selectable: 1, 2, 5 ms) in every mode, and REBUILT now stages the manual's **408** neutral FUEL (it was 150 at 1 ms). Worst case (plowing the whole pile) is about 1.6x real time at 2 ms.
- `EngineConfig.tuning` (`src/engine/types.ts`): CCD policy (`all`, `none`, `fast`, `soft`), solver iteration, contact frequency, prediction distance and `pile`.
- **Pile manager** (`src/engine/pile.ts`): FUEL that has been at rest for 0.4 s becomes a fixed body; frozen FUEL is thawed when the robot comes within about 1.1 m (plus its speed times 0.15 s) or when a moving FUEL (faster than 0.3 m/s) comes within 0.36 m, so a disturbance spreads from piece to piece. Everything is decided from body state in a fixed order, never from wall time; snapshots and restores carry the rest counters; the state hash includes the frozen count. A laid-out pile starts frozen. Tests: `tests/pile.test.ts` (plowing moves FUEL as far as the plain solver within 35%, repeats exactly, restores mid-disturbance).
- Not changed: the default engine (no `tuning`) behaves exactly as before; the golden hash is unchanged.

## What we found about other simulators (read this with the caveats)

- **rebuilt.frsim.com** (the page is only a menu: Singleplayer, Multiplayer, Ranked, Leaderboard, Replays; "Beta v35"; credits Athan Wang and Ryan Dong of FRC 7558 ALT F4, presented by WCP Canada). The page states nothing about its physics. The nearest primary source is the author thread for the sister site firstroboticsim.com on Chief Delphi (https://www.chiefdelphi.com/t/a-new-age-of-frc-sims-introducing-first-robotics-sim-unofficial/524544): Next.js, three.js through React Three Fiber, **Rapier (WebAssembly) at a fixed 60 Hz** on an authoritative server, the client predicting its own robot and the renderer interpolating; "every FUEL is a real physics object"; physics "turned down" for slow devices. That the two sites are the same project is an inference (matching titles, Discord and sponsors), not something either states. So the likely reason it does not lag is mostly a **60 Hz step** (16 times fewer steps per second than our 1 ms) on a Rapier engine like ours, not a different technique. We did not look at its code or network traffic.
- **TylerHandel/rebuilt-sim-2026** (https://github.com/TylerHandel/rebuilt-sim-2026): three.js + Rapier, all 504 FUEL, a 120 Hz step with 8 sub-steps for contacts too fast for one step, soft-contact foam FUEL, instanced rendering, "FUEL already sleep in Rapier once at rest"; its README reports FUEL at about 49 to 55 ms CPU per simulated second out of about 190 to 200 ms for the whole Rapier step. Our 408-FUEL cost at 1 ms is 1200 ms per simulated second; the difference is the step rate again (120 Hz against 1000 Hz).
- **KyvanChen/rebuild-arena** (https://github.com/KyvanChen/rebuild-arena): three.js + Rapier, FUEL collide with simple shapes, collisions decided on the host in multiplayer, an option of about 1000 FUEL.
- **MoSim REBUILT devlog** (https://www.chiefdelphi.com/t/mosim-rebuilt-devlog/515773): fully physics based, authors call the field resource-intensive and are simplifying it; engine not named. **hammerheads5000/FuelSim** (Java, robot-code side): ball-ball and field collisions, 20 ms stepped in 5 sub-ticks by default (about 4 ms). **maple-sim** and MARSLib use dyn4j (2D); maple-sim's `RebuiltFuelOnFly` projectile is gravity-only.
- Not found: any statement of frsim's ball-ball simplification, pooling or WebGPU use.

## General techniques (from Rapier docs and source, a few forum threads; no one published a 400-sphere Rapier benchmark, so none of the gains below are from a source)

- Sleeping is per island, so a pile that is touched wakes as a whole (what we measured). Keeping far pieces frozen (what `pile.ts` does) is the hand-rolled answer; Rapier's JS build does not expose the sleep thresholds.
- CCD matters only for fast pieces, and two CCD bodies can still tunnel through each other; at 1 to 2 ms a 15 cm ball needs well over 100 m/s to tunnel through 15 cm geometry.
- Rapier docs suggest 1 to 2 solver iterations when speed matters most; we already use 2 for REBUILT and measured no further gain from 1.
- A fixed pair of collision groups prunes pairs right after the broadphase; leave collider events off on FUEL.
- Reading transforms per body is a known cost in other bindings; the viewer already reads only awake pieces. Box2D v3's "soft step" (contacts once per step, several cheap solver sub-steps) validates a coarse step with sub-stepping.
- GPU (WebGPU) particle approaches exist but would break bit-for-bit determinism and are a rewrite; not pursued.

## Ideas not done yet (largest first)

1. **Different step sizes for the pile and the robot.** Run the FUEL world at 5 to 8 ms and only the swerve model and mechanisms at 1 ms, passing the robot's force to the pile world each coarse step. Probably the biggest remaining gain (the frsim and TylerHandel numbers suggest 60 to 120 Hz is enough for foam FUEL), at the price of a coupling layer.
2. A sphere-only solver for settled FUEL in contact with the robot, and soft-contact foam (stiffness rising with squash) in place of Rapier's rigid contact plus restitution curve.
3. Sub-stepping only near fast contacts (as TylerHandel does: 8 sub-steps per step for fast pieces).
4. Read piece transforms in bulk into one typed array for the viewer (only matters if drawing becomes the bottleneck).
