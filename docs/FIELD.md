# The REBUILT field: where it comes from

The field is built from FIRST's official CAD (the Onshape document "FE-2026: REBUILT Playing Field", Welded perimeter, exported as GLB and STEP).

- **Look:** `app/assets/field/rebuilt-field.glb` (7 MB) is made from the 70 MB CAD export by `app/tools/build-field.mjs`:
  node tools/build-field.mjs [CAD.glb] [output dir]
  It bakes the sim's frame (x = 8.2705 - x_cad, y = 4.0345 - y_cad: origin at the blue wall corner, +X toward the red wall), drops the FUEL, fasteners and
  hidden internals, simplifies the rest (1.5 mm), merges by material, quantizes, and writes `rebuilt-field.json` next to it: every element's box, the 32 AprilTag
  centres, where each of the 456 FUEL sits, the HUB funnel and the BUMP gable. The app loads the GLB for the live view and for REBUILT sims
  (View > Collision shapes shows the physics bodies instead).
- **Physics:** `app/src/games/rebuilt.ts` builds the bodies from numbers measured in the CAD, which `app/src/games/rebuilt-cad.ts` holds (generated from the JSON):
  the HUB's hexagonal funnel (vertices on the field X axis, 60 degrees, throat 0.395 m below the 1.829 m rim), BUMP gable (0.1654 m), TRENCH, DEPOT, TOWER,
  1.99 m alliance walls, and the 360 + 48 FUEL start positions.
- **Vision:** the AprilTag layout in `app/src/engine/vision.ts` is the official 2026 layout (32 tags); it agrees with the CAD to 3.3 mm.
- **Not in the CAD, still assumed:** where the HUB's sensor array reads (a little below the throat), where processed FUEL comes out of the HUB, FUEL bounce and friction,
  and the OUTPOST chutes (24 FUEL each, behind the alliance walls).
