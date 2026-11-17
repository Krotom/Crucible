// The OffSeason robot, loaded from robots/offseason/robot.yaml (the values and where each one comes from are there).
import raw from '../../robots/offseason/robot.yaml?raw'
import { parseDefinition } from './definition'

export const OFFSEASON = parseDefinition(raw)
export const OFFSEASON_DRIVETRAIN = OFFSEASON.drivetrain
export const OFFSEASON_HALF = OFFSEASON.bumper
