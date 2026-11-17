// The OffSeason robot's drivetrain, from TunerConstants.java in the robot project. Values marked GUESS are not in the
// code and need measuring (they become the robot definition file in M4).
import { KRAKEN_X60, type DrivetrainSpec } from '../engine/drivetrain'

const IN = 0.0254
const HALF = 11.415 * IN // module offset from the center, both axes

export const OFFSEASON_DRIVETRAIN: DrivetrainSpec = {
  mass: 52, // GUESS: robot weight with bumpers and battery, kg
  wheelRadius: 2 * IN,
  driveRatio: 7.03125,
  steerRatio: 26.09090909090909,
  couplingRatio: 4.5,
  driveMotor: KRAKEN_X60,
  steerMotor: KRAKEN_X60,
  driveInertia: 0.01, // kDriveInertia
  steerInertia: 0.01, // kSteerInertia
  driveFrictionVolts: 0.2,
  steerFrictionVolts: 0.2,
  driveCurrentLimit: 120, // kSlipCurrent
  steerCurrentLimit: 60,
  mu: 1.2, // GUESS: tread on carpet
  slipSpeed: 0.05, // tire stiffness knob
  pigeonId: 1,
  modules: [
    { x: HALF, y: HALF, driveId: 20, steerId: 21, encoderId: 22 }, // front left
    { x: HALF, y: -HALF, driveId: 23, steerId: 24, encoderId: 25 }, // front right
    { x: -HALF, y: HALF, driveId: 26, steerId: 27, encoderId: 28 }, // back left
    { x: -HALF, y: -HALF, driveId: 29, steerId: 30, encoderId: 31 }, // back right
  ],
}

/** Bumper footprint half extents (m): GUESS 0.43 square, 0.12 tall, until the CAD is measured. */
export const OFFSEASON_HALF: [number, number, number] = [0.43, 0.43, 0.12]
