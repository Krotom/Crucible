# Shot calibration

efficiency 0.623, backspin 0.413; rms error 0.694 m before, 0.010 m after (90 simulations)

**Check:**
- backspin is weakly determined by these shots (moving it by 0.1 changes the error by only -0.001 m): add shots at other hood angles and flywheel speeds, and some measured at the HUB height

| # | flywheel (rps) | hood (deg) | measured (m) | predicted (m) | error (m) |
|---|---|---|---|---|---|
| 1 | 40.0 | 62.0 | 1.85 | 1.85 | 0.00 |
| 2 | 45.0 | 58.0 | 2.47 | 2.48 | 0.01 |
| 3 | 50.0 | 66.0 | 2.39 | 2.38 | -0.01 |
| 4 | 55.0 | 60.0 | 3.32 | 3.33 | 0.01 |
| 5 | 60.0 | 64.0 | 3.46 | 3.45 | -0.01 |
| 6 | 65.0 | 57.0 | 4.69 | 4.69 | 0.00 |
| 7 | 48.0 | 70.0 | 1.91 | 1.90 | -0.01 |
| 8 | 52.0 | 55.0 | 3.33 | 3.35 | 0.02 |

```yaml
# from a shot fit of 8 shots (rms 0.694 m before, 0.010 m after)
efficiency: 0.623
backspin: 0.413
```
