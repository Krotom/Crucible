# REBUILT rules extract (for review)

Status: **draft for your review, nothing is implemented yet.** Per the plan, `game-rebuilt` is written only after you have read and corrected this
file, and any later rule change updates this file first.

## 0. Sources and how I read them

| Source | What I took from it |
|---|---|
| [2026 Game Manual, HTML](https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm) (read verbatim up to rule R203; the manual shows no revision number) | Field, elements, FUEL, match timing, scoring, rules G### and R### |
| [Combined Team Updates 00 to 22](https://firstfrc.blob.core.windows.net/frc2026/Manual/TeamUpdates/REBUILT_TeamUpdate-Combined.pdf) (text extracted locally; 22 is the final update, 2026-04-21) | Rule changes after the manual; none change scoring values, timing or FUEL |
| [WPILib 2026 game data page](https://docs.wpilib.org/en/stable/docs/yearly-overview/2026-game-data.html) | The Game Data string the robot receives |
| [Game overview PDF](https://www.firstinspires.org/hubfs/web/volunteer/frc/2026-rebuilt-game-overview.pdf?hsLang=en) | Plain-language summary (agrees with the manual) |

**Not read, and needed for a few numbers:** the [2026 Field Dimension Drawings](https://firstfrc.blob.core.windows.net/frc2026/FieldAssets/2026-field-dimension-dwgs.pdf)
(over 10 MB, my fetch tool refused it) and the official CAD. The manual itself says the drawings and the 3D CAD are the official dimensions and the manual's
numbers are nominal (5.1). Gaps that depend on them are marked **GAP**. If you can drop the PDF into the project (or give me the Onshape export), I will read them.

Marks used below: **V** = verbatim from the manual or a Team Update, **I** = my inference, **N** = not stated.

## 1. Coordinates (assumption, please confirm)

The manual defines no coordinate system (**N**). I use the WPILib/AdvantageScope convention your robot code already uses: origin at the blue alliance
wall corner, +X toward the red wall, +Y left when facing the red wall, Z up, meters. Field extent **651.2 in x 317.7 in (16.54 m x 8.07 m)** (5.2, **V**; which
dimension is which is **I**, from the ALLIANCE ZONE being "158.6in deep by 317.7in long", 5.3).

## 2. Field elements (5.2 to 5.9)

Counts (5.2, V): 1 OUTPOST, 1 HUB and 1 TOWER per alliance, 2 DEPOTS (one per alliance), 4 BUMPS, 4 TRENCHES. Surface: low pile carpet; carpet and tape must be drivable (5.2, V).
Guardrail: 20.0 in (50.8 cm) tall transparent polycarbonate along the long edges; gate passthrough 38.0 in (96.5 cm) wide, gates closed during the match (5.2, V). Marking tape 2.0 in (5.1 cm) wide (5.3, V).

| Zone (5.3, V) | Size |
|---|---|
| ALLIANCE AREA | about 360 in x 134 in (9.14 m x 3.4 m) |
| ALLIANCE ZONE | 158.6 in deep x 317.7 in long (4.03 m x 8.07 m); holds a TOWER and a DEPOT |
| NEUTRAL ZONE | 283 in deep x 317.7 in long (7.19 m x 8.07 m); bounded by BUMPS, TRENCHES, HUBS, guardrails; contains the CENTER LINE |
| HUMAN STARTING LINE | 24.0 in (61.0 cm) from the bottom square tube of the ALLIANCE WALL |
| OUTPOST AREA | 71.0 in x 134 in (1.8 m x 3.4 m) |

**HUB (5.4, V unless marked)**
- Base 47 in x 47 in (about 1.19 m) rectangular prism. **Overall height: N (GAP).**
- "centered between two BUMPS located 158.6in (about 4.03m) away from their ALLIANCE WALL". **Ambiguous:** is 4.03 m the near face or the center? Your robot code puts the blue hub at
  (4.6, 4.0); 4.03 m + half the base (0.595 m) = 4.625 m, so the code's 4.6 matches "near face at 4.03 m". I will use **center x = 4.625 m, y = 4.035 m for blue and
  x = 16.54 - 4.625 = 11.915 m for red** unless you or the drawing say otherwise (**I**).
- Top opening: 41.7 in (about 1.06 m) hexagonal; front edge 72 in (about 1.83 m) off the carpet. The opening's orientation and exact center are **GAP**.
- Four exits at the base facing the NEUTRAL ZONE; processed FUEL is distributed through them "randomly". Exit positions, the delay and the exit speed are **N (GAP)**.
- A net at the back keeps FUEL launched from "most prohibited areas" out of the opening. Net dimensions **N**.
- Lighting (Table 5-3, TU14): alliance color = active; pulsing = deactivation warning starting 3 s before deactivation; during the TRANSITION SHIFT a white chase marks the HUB that will be inactive in SHIFT 1.

**BUMP (5.5, V):** 73.0 in (1.854 m) wide, 44.4 in (1.128 m) deep, 6.513 in (16.54 cm) tall; 0.5 in HDPE ramps at 15 degrees (one sloping each way); two per side of each HUB.
Friction **N**.

**TRENCH (5.6, V):** 65.65 in (1.668 m) wide, 47.0 in (1.194 m) deep, 40.25 in (1.022 m) tall; clearance under each arm 50.34 in (1.279 m) wide x 22.25 in (56.52 cm) tall; runs from the guardrail to the BUMP on both sides of the field.

**DEPOT (5.7, V; unchanged by TU14):** 42.0 in (1.07 m) wide, 27.0 in (68.6 cm) deep along the ALLIANCE WALL; 3.0 in wide x 1.0 in tall steel barriers (about 1.125 in with the hook fastener).

**TOWER (5.8, V):** overall 49.25 in (1.251 m) wide, 45.0 in (1.143 m) deep, 78.25 in (1.988 m) tall, in the ALLIANCE WALL between DRIVER STATIONS 2 and 3. Base plate 39.0 in x 45.18 in. Two uprights 72.1 in (1.831 m) tall, 32.25 in apart.
Rungs (1.66 in OD), centers above the floor: LOW 27.0 in (68.58 cm), MID 45.0 in (114.3 cm), HIGH 63.0 in (1.6 m), 18.0 in apart; each extends 5.875 in beyond the upright's outer face.

**ALLIANCE WALL / OUTPOST (5.9, V):** OUTPOST upper opening 31.8 in x 7.0 in (bottom 28.1 in off the floor); CHUTE sloped 15 degrees holding about 25 FUEL behind a CHUTE DOOR; base opening into the CORRAL 32.0 in x 7.0 in (bottom 1.88 in off the ground);
CORRAL floor 35.8 in x 37.6 in with 8.13 in tall panels. Alliance wall overall length **N**.

AprilTags (5.11, V): 36h11 family, IDs 1 to 32, 8.125 in square; HUB tags centers 44.25 in off the floor, TOWER WALL and OUTPOST 21.75 in, TRENCH 35 in. Field positions are in the drawings (GAP, not needed for physics).

## 3. FUEL (5.10, 6.3.4, V)

- 5.91 in (15.0 cm) diameter high-density foam ball, mass **0.448 to 0.500 lb (0.203 to 0.227 kg)**; compression, bounce and friction **N**. (My test ball uses 0.2 kg and radius 0.075 m.)
- **504 FUEL per match** (6.3.4, unchanged for championships by TU19 and TU22): 24 in each DEPOT, 24 in each OUTPOST CHUTE, up to 8 preloaded per robot (up to 48 total), and the rest in the NEUTRAL ZONE: **360 to 408 depending on preloads**, tolerance +/- 24, corralled in a box about 206.0 in x 72.0 in (5.23 m x 1.83 m) with a 2.0 in divider removed before the match, roughly equal on both sides of the CENTER LINE (6.3.4.1). A single square-packed layer of that box holds about 408 balls (34 x 12), so the real layout is close to one dense layer with some piling.
- Preload rule (G303.I, V): a robot may fully support not more than 8 FUEL at match start. In match: "a ROBOT may CONTROL any number of SCORING ELEMENTS" (5.10, V); no cap.
- FUEL that leaves the field (other than through the OUTPOST base opening) is put back near the point of exit by field staff (6.8, TU01, V).

## 4. Match flow (6.1, 6.4, V)

2:40 total. **AUTO 20 s** (0:20 to 0:00). A **3 s delay** follows for scoring (6.4). **TELEOP 2:20**:

| Period | Duration | Clock |
|---|---|---|
| TRANSITION SHIFT | 10 s | 2:20 to 2:10 |
| SHIFT 1 | 25 s | 2:10 to 1:45 |
| SHIFT 2 | 25 s | 1:45 to 1:20 |
| SHIFT 3 | 25 s | 1:20 to 0:55 |
| SHIFT 4 | 25 s | 0:55 to 0:30 |
| END GAME | 30 s | 0:30 to 0:00 |

**HUB activity (6.4.1, Table 6-3, V):** both HUBs are active in AUTO, TRANSITION SHIFT and END GAME. "The ALLIANCE that scores the most FUEL during AUTO will have their HUB set to inactive for SHIFT 1"; if tied, the field system picks one at random. The statuses
then alternate every shift: the AUTO winner's HUB is inactive in SHIFTS 1 and 3 and active in SHIFTS 2 and 4, the other alliance the opposite. Both return to active at END GAME.
Game Data (WPILib page): one character, `R` or `B`, the alliance whose HUB goes inactive first (the AUTO winner by FUEL count), sent about 3 s after AUTO ends; empty until then.

**Grace periods (6.5, V):** FUEL scored in a HUB is still assessed for **3 s after the HUB deactivates**; FUEL assessment continues for up to 3 s after the clock reaches 0:00 following AUTO and following TELEOP. TOWER in TELEOP is assessed 3 s after 0:00 or when all robots are at rest, whichever is first.

## 5. Scoring (6.5, Table 6-4 and 6-5, V)

| Item | AUTO | TELEOP |
|---|---|---|
| FUEL in an **active** HUB | 1 | 1 |
| FUEL in an inactive HUB | 0 | 0 |
| TOWER LEVEL 1 | 15 (max 2 robots) | 10 |
| TOWER LEVEL 2 | not available | 20 |
| TOWER LEVEL 3 | not available | 30 (**I**: the table shows one value, and 6.5.2 allows only LEVEL 1 in AUTO) |

- **Counts as scored (6.5.1, V):** "once it passes through the top opening of the HUB and through the sensor array." Whether a ball that bounces back out after the sensor counts again, and the sensor array's position below the opening, are **N**.
- **TOWER (6.5.2, V):** LEVEL 1: robot "no longer touching the CARPET or the TOWER BASE"; LEVEL 2: bumper covers completely above the LOW RUNG; LEVEL 3: completely above the MID RUNG; contact with a RUNG or UPRIGHT; one level per robot in TELEOP; AUTO LEVEL 1 plus a TELEOP level is allowed.
- **Bonus ranking points (1 each; Table 6-5, final in TU22):** ENERGIZED 100 / 240 / 360 FUEL, SUPERCHARGED 360 / 360 / 500 FUEL, TRAVERSAL 50 / 50 / 50 TOWER points (Regional-District / District Championship / FIRST Championship). The manual says the FUEL thresholds count "FUEL scored in an active HUB".
- **Win/Tie RP: not confirmed (N).** The text I could read shows "Win ... 1" and no Tie row; I will not assume 3/1.
- **Fouls (6.6, V):** MINOR FOUL credits the opponent 5 points, MAJOR FOUL 15. TECH FOUL is not defined in the text I read. YELLOW and RED CARDS carry no points (a second yellow becomes red); DISQUALIFIED = 0 match points and 0 RP in qualification.

## 6. Rules the simulator could enforce (7.x, 8.x, V; each is optional, see section 8)

| Rule | What it says | Penalty |
|---|---|---|
| G403 (changed by TU22) | In AUTO a robot may not completely cross the CENTER LINE (bumpers completely across), plus a foul per contact with an opponent | MAJOR FOUL (+ per contact) |
| G407 | Launch into your HUB only when your bumpers are at least partly in your ALLIANCE ZONE | MAJOR FOUL |
| G408 | Do not catch FUEL leaving the HUB: no more than momentary control and no redirecting, per instance | MINOR FOUL; MAJOR if strategic |
| G405 | Do not eject FUEL from the field except through the OUTPOST base opening | MINOR FOUL; MAJOR if repeated |
| G413 / R105 to R107 | Expansion limits: 12 in beyond the perimeter, one direction at a time, 30 in tall; exceptions for damage and "momentary" | MINOR; MAJOR if strategic |
| G415, G416 (rewritten by TU14 and TU19) | Contact limits inside an opponent's perimeter | MAJOR + cards |
| G418 | Pinning an opponent more than 3 s | MINOR + MAJOR per 3 s |
| G420 | No contact with an opponent robot on its TOWER in the last 30 s | MAJOR; opponent awarded LEVEL 3 |
| G427 (TU14) | OUTPOST storage limit (human player) | MINOR; MAJOR if continuous |

Robot limits for context (V): weight 115.0 lb (52.16 kg) without bumpers and battery (R103), starting perimeter 110.0 in (R104), height 30 in (R104, R107); bumpers up to 4.0 in thick (R403, summary), total weight with bumpers 135.0 lb (R408).
Your robot's mass guess of 52 kg is at the limit; bumpers and battery add to it.

## 7. What is not in the extract and why it matters

1. **HUB overall height and the top opening's center and orientation (GAP).** The ball must pass the opening at 72 in; the sensor array depth decides what counts. I can score a ball when its center passes down through the opening hexagon at or above the 72 in plane and then below a sensor plane, but the depth is a guess without the drawing.
2. **Where processed FUEL comes out (GAP).** Four exits "facing the NEUTRAL ZONE", random distribution, no timing. This matters for gameplay (scored balls come back onto the field).
3. **Human player and OUTPOST behavior.** 24 FUEL per CHUTE and the CORRAL storage exist, but how fast a human player feeds is not a rule.
4. **FUEL contact material** (bounce, friction, compression) is not stated, so the foam curve stays a calibration knob (M12).
5. **Win/Tie RP and TECH FOUL values** not confirmed.

## 8. Proposed scope for `game-rebuilt` (please edit)

**Will model (v1):**
- The field as colliders: guardrails, alliance walls, both TOWER walls, 4 BUMPS (15 degree ramps), 4 TRENCH posts and rails, 2 DEPOTS, HUB bodies with the top opening and the back net, OUTPOST faces.
- 504 FUEL staged as in 6.3.4 (neutral zone pile, 24 per DEPOT, 24 per CHUTE as a queue the human player releases, up to 8 preloaded per robot); the engine's ball budget (S3: a few hundred active, the rest asleep) fits.
- Match flow: AUTO 20 s, 3 s scoring delay, TRANSITION, four shifts, END GAME; HUB activation by the AUTO winner (random on a tie); the 3 s deactivation grace; Game Data `R`/`B` sent to the robot (the robot bridge needs to carry it: the contract has no field for it yet).
- Scoring: 1 point per FUEL through an active HUB, bonus RP thresholds shown in the scoreboard, TOWER levels by the criteria in 6.5.2 (needs robot-on-rung detection, probably last).
- Events for the HUD and analytics: FUEL scored (with HUB state), shots, captures.

**Optional, tell me which you want:** G407 (launching from outside your zone) and G403 (AUTO center line) with their 15-point credits; G405 (ejecting FUEL); G408; the contact fouls G415 to G418 (judgment calls, I would leave out).

**Will not model:** referee judgment, cards, ranking, schedule, human player skill, field faults.

## 9. Questions for you

1. Is the **coordinate convention** in section 1 right, and is the HUB **center x = 4.625 m** (near face at 4.03 m)?
2. Can you provide the **Field Dimension Drawings** (or the official CAD) so I can read the HUB height, opening position, exits and the full field element layout? Otherwise I will use the manual's numbers plus clearly marked assumptions.
3. **Scope in section 8:** anything to add or cut? In particular, rule fouls: none, G407 and G403 only, or more?
4. **Scored FUEL:** return it to the field through the HUB exits after a delay (what the manual describes), or just remove it? I recommend returning it, with the exit positions as assumptions until the drawings.
5. **TOWER** (climb scoring): v1 or later? The robot code has no climber, so I suggest later.
