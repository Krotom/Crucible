// Loads and checks a robot definition (YAML) and compares it with what the connected robot says about itself.
import { parse } from 'yaml'
import type { DrivetrainSpec } from '../engine/drivetrain'
import type { MechanismSpec } from '../engine/mechanism'
import { MOTORS } from '../engine/motors'

export interface RobotDefinition {
  name: string
  mass: number
  bumper: [number, number, number]
  start: { x: number; y: number; yaw: number }
  drivetrain: DrivetrainSpec
  mechanisms: MechanismSpec[]
}

type Obj = Record<string, unknown>

function num(o: Obj, key: string, where: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`robot definition: ${where}.${key} must be a number`)
  return v
}

function str(o: Obj, key: string, where: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v === '') throw new Error(`robot definition: ${where}.${key} must be text`)
  return v
}

function obj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`robot definition: ${where} must be a mapping`)
  return v as Obj
}

function motorOf(o: Obj, key: string, where: string): string {
  const name = str(o, key, where)
  if (!MOTORS[name]) throw new Error(`robot definition: ${where}.${key} "${name}" is not a known motor (${Object.keys(MOTORS).join(', ')})`)
  return name
}

export function parseDefinition(text: string): RobotDefinition {
  const root = obj(parse(text), 'file')
  const chassis = obj(root.chassis, 'chassis')
  const swerve = obj(root.swerve, 'swerve')
  const bumper = chassis.bumper
  if (!Array.isArray(bumper) || bumper.length !== 3 || bumper.some((x) => typeof x !== 'number')) throw new Error('robot definition: chassis.bumper must be three numbers')
  const start = obj(chassis.start, 'chassis.start')
  const mods = swerve.modules
  if (!Array.isArray(mods) || mods.length === 0) throw new Error('robot definition: swerve.modules must be a list')

  const drivetrain: DrivetrainSpec = {
    mass: num(chassis, 'mass', 'chassis'),
    wheelRadius: num(swerve, 'wheelRadius', 'swerve'),
    driveRatio: num(swerve, 'driveRatio', 'swerve'),
    steerRatio: num(swerve, 'steerRatio', 'swerve'),
    couplingRatio: num(swerve, 'couplingRatio', 'swerve'),
    driveMotor: MOTORS[motorOf(swerve, 'driveMotor', 'swerve')],
    steerMotor: MOTORS[motorOf(swerve, 'steerMotor', 'swerve')],
    driveInertia: num(swerve, 'driveInertia', 'swerve'),
    steerInertia: num(swerve, 'steerInertia', 'swerve'),
    driveFrictionVolts: num(swerve, 'driveFrictionVolts', 'swerve'),
    steerFrictionVolts: num(swerve, 'steerFrictionVolts', 'swerve'),
    driveCurrentLimit: num(swerve, 'driveCurrentLimit', 'swerve'),
    steerCurrentLimit: num(swerve, 'steerCurrentLimit', 'swerve'),
    mu: num(swerve, 'mu', 'swerve'),
    slipSpeed: num(swerve, 'slipSpeed', 'swerve'),
    pigeonId: num(swerve, 'pigeonId', 'swerve'),
    modules: mods.map((m, i) => {
      const o = obj(m, `swerve.modules[${i}]`)
      const w = `swerve.modules[${i}]`
      return { x: num(o, 'x', w), y: num(o, 'y', w), driveId: num(o, 'driveId', w), steerId: num(o, 'steerId', w), encoderId: num(o, 'encoderId', w) }
    }),
  }

  const list = root.mechanisms
  if (!Array.isArray(list)) throw new Error('robot definition: mechanisms must be a list')
  const ids = new Set<number>()
  const mechanisms = list.map((m, i): MechanismSpec => {
    const o = obj(m, `mechanisms[${i}]`)
    const w = `mechanisms[${i}]`
    const spec: MechanismSpec = {
      id: num(o, 'id', w), name: str(o, 'name', w), motor: motorOf(o, 'motor', w), count: num(o, 'count', w),
      gearRatio: num(o, 'gearRatio', w), inertia: num(o, 'inertia', w),
    }
    if (ids.has(spec.id)) throw new Error(`robot definition: duplicate id ${spec.id} in mechanisms`)
    ids.add(spec.id)
    if (o.frictionVolts !== undefined) spec.frictionVolts = num(o, 'frictionVolts', w)
    if (o.limits !== undefined) { const l = obj(o.limits, `${w}.limits`); spec.limits = { min: num(l, 'min', `${w}.limits`), max: num(l, 'max', `${w}.limits`) } }
    return spec
  })

  return {
    name: str(root, 'robot', 'file'),
    mass: drivetrain.mass,
    bumper: bumper as [number, number, number],
    start: { x: num(start, 'x', 'chassis.start'), y: num(start, 'y', 'chassis.start'), yaw: num(start, 'yaw', 'chassis.start') },
    drivetrain,
    mechanisms,
  }
}

interface HelloMechanism { id: number; motor: string; count: number; ratio: number; inertia: number }
interface Hello { protocol?: number; devices?: { type: string; id: number }[]; mechanisms?: HelloMechanism[] }

/**
 * Compares the definition with the robot's Hello message. Returns one sentence per problem (empty when they agree):
 * ids the robot has that the definition cannot simulate, ids the definition expects that the robot lacks, and mechanisms
 * whose motor, count or gear ratio differ. Inertia differences are not problems: the definition may refine them.
 */
export function checkAgainstHello(def: RobotDefinition, helloJson: string): string[] {
  let hello: Hello
  try { hello = JSON.parse(helloJson) as Hello } catch { return ['the robot\'s Hello message is not valid JSON'] }
  const issues: string[] = []
  if (hello.protocol !== 0) issues.push(`robot speaks bridge protocol ${hello.protocol}, the app expects 0`)
  const robotMotors = new Set((hello.devices ?? []).filter((d) => d.type === 'talonfx').map((d) => d.id))
  const swerveMotors = new Set(def.drivetrain.modules.flatMap((m) => [m.driveId, m.steerId]))
  const defMotors = new Set([...swerveMotors, ...def.mechanisms.map((m) => m.id)])
  const missing = [...defMotors].filter((id) => !robotMotors.has(id)).sort((a, b) => a - b)
  const extra = [...robotMotors].filter((id) => !defMotors.has(id)).sort((a, b) => a - b)
  if (missing.length) issues.push(`the definition has motors the robot does not register: ${missing.join(', ')}`)
  if (extra.length) issues.push(`the robot registers motors the definition has no model for (they will not move): ${extra.join(', ')}`)
  const robotCancoders = new Set((hello.devices ?? []).filter((d) => d.type === 'cancoder').map((d) => d.id))
  const defCancoders = def.drivetrain.modules.map((m) => m.encoderId)
  const lacking = defCancoders.filter((id) => !robotCancoders.has(id))
  if (lacking.length) issues.push(`the definition expects CANcoders the robot does not register: ${lacking.join(', ')}`)
  for (const m of hello.mechanisms ?? []) {
    const d = def.mechanisms.find((x) => x.id === m.id)
    if (!d) continue
    if (d.motor !== m.motor || d.count !== m.count) issues.push(`${d.name} (id ${d.id}): robot has ${m.count} x ${m.motor}, definition says ${d.count} x ${d.motor}`)
    if (Math.abs(d.gearRatio - m.ratio) > 1e-6) issues.push(`${d.name} (id ${d.id}): robot gear ratio ${m.ratio}, definition says ${d.gearRatio}`)
  }
  return issues
}
