# Crucible app (M1: viewer)

Electron + TypeScript + three.js. At this stage the app is a viewer for an existing robot: it connects to a running
robot over NetworkTables 4 or opens a `.wpilog`, shows the robot in 3D and plots numeric topics. The physics engine
and the sim bridge come in M2 and M3.

## Run

```bash
npm install
npm run dev        # Electron window (renderer served by Vite, so the robot model is available)
npm run web        # renderer only, in a normal browser at http://localhost:5174 (handy for quick checks)
npm test           # parser, struct and NT4 client tests
npm run typecheck
```

If Electron reports "Electron uninstall", its binary was not downloaded; run `node node_modules/electron/install.js`.

## Using it

- **Live:** start the robot sim (`./gradlew simulateJava`), enter the host (default `127.0.0.1`) and press Connect.
  The app subscribes to every topic on port 5810 and reconnects by itself.
- **Log:** Open log… or drop a `.wpilog` on the window. Space plays and pauses, the slider and a click on the plot
  seek. Truncated logs (power loss) open with every complete record.
- **3D view:** the robot pose and the component poses follow the two pickers in the top left; they are chosen
  automatically (`Swerve/Pose`, `Mechanism3d/Components`). Orbit with the left mouse button, pan with the right one.
- **Plot:** click a numeric topic in the list to add or remove it; each line is decimated to 6000 points.

## Robot model

The model folder uses the AdvantageScope layout (`model.glb` for the chassis, `model_N.glb` per component,
`config.json`). It is not stored in this repo (about 26 MB). The folder is found in this order:
`CRUCIBLE_MODEL_DIR`, `modelDir` in `app/crucible.config.json` (git-ignored), then the sibling robot repo at
`../../OffSeasonCode/OffSeasonCode/advantagescope/Robot_OffSeason`. The dev server serves it at `/model/*`; a packaged
build will bundle the model from the robot definition (M4).

To check the renderer in a plain browser against a real log: `CRUCIBLE_SAMPLE_LOG=<path> npm run web`, then in the console
`fetch('/dev-sample-log').then(r => r.blob()).then(b => crucible.openLogFile(new File([b], 'x.wpilog')))`.

## Layout

| Path | Role |
|---|---|
| `src/main`, `src/preload` | Electron shell (thin for now) |
| `src/renderer/src/lib/wpilog.ts` | `.wpilog` reader: indexes records, decodes lazily (a 60 MB log opens in about 0.4 s) |
| `src/renderer/src/lib/structs.ts` | WPILib struct decoding (Pose2d, Pose3d, ...) |
| `src/renderer/src/lib/store.ts` | One data model for log and live sources |
| `src/renderer/src/lib/nt4.ts` | NT4 client |
| `src/renderer/src/lib/scene.ts` | three.js scene in WPILib coordinates (Z up) |
| `src/renderer/src/lib/plot.ts` | uPlot panel |
| `tests/` | unit tests; `real-log.test.ts` runs only when `CRUCIBLE_SAMPLE_LOG` is set |

## Known limits (M1)

- The field is a placeholder rectangle (16.541 x 8.069 m); the real field comes with the REBUILT module (M6).
- Only struct types made of doubles are decoded (poses, translations, rotations, speeds, module states).
- A production build (`npm run build`) does not yet serve the robot model; use `npm run dev`.
- Live data is kept as the last 60 000 samples per topic.
