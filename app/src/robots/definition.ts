// Loads and checks a robot definition (YAML) and compares it with what the connected robot says about itself.
import { parse } from 'yaml'
import type { DrivetrainSpec } from '../engine/drivetrain'
import type { MechanismSpec } from '../engine/mechanism'
import type { BallHandlingSpec, Vec3 } from '../engine/types'
import { MOTORS } from '../engine/motors'

export interface RobotDefinition {
  name: string
  mass: number
  bumper: [number, number, number]
  start: { x: number; y: number; yaw: number }
  drivetrain: DrivetrainSpec
  mechanisms: MechanismSpec[]
  balls?: BallHandlingSpec
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

  const balls = root.ballHandling === undefined ? undefined : parseBalls(obj(root.ballHandling, 'ballHandling'), new Set(mechanisms.map((m) => m.name)))

  return {
    name: str(root, 'robot', 'file'),
    mass: drivetrain.mass,
    bumper: bumper as [number, number, number],
    start: { x: num(start, 'x', 'chassis.start'), y: num(start, 'y', 'chassis.start'), yaw: num(start, 'yaw', 'chassis.start') },
    drivetrain,
    mechanisms,
    balls,
  }
}

function vec3(v: unknown, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'number')) throw new Error(`robot definition: ${where} must be three numbers`)
  return v as Vec3
}

function mech(o: Obj, key: string, where: string, names: Set<string>): string {
  const name = str(o, key, where)
  if (!names.has(name)) throw new Error(`robot definition: ${where}.${key} "${name}" is not a mechanism in the list above`)
  return name
}

function sign(o: Obj, key: string, where: string): 1 | -1 {
  const v = num(o, key, where)
  if (v !== 1 && v !== -1) throw new Error(`robot definition: ${where}.${key} must be 1 or -1`)
  return v
}

function parseBalls(b: Obj, names: Set<string>): BallHandlingSpec {
  const i = obj(b.intake, 'ballHandling.intake')
  const sh = obj(b.shooter, 'ballHandling.shooter')
  const box = obj(i.openBox, 'ballHandling.intake.openBox')
  const stages = b.stages
  const beams = b.beams
  if (!Array.isArray(stages) || stages.length === 0) throw new Error('robot definition: ballHandling.stages must be a list')
  if (!Array.isArray(beams)) throw new Error('robot definition: ballHandling.beams must be a list')
  const axis = sh.axis
  if (!Array.isArray(axis) || axis.length !== 2 || axis.some((x) => typeof x !== 'number')) throw new Error('robot definition: ballHandling.shooter.axis must be two numbers')
  const w = 'ballHandling.intake'
  const s = 'ballHandling.shooter'
  return {
    piece: str(b, 'piece', 'ballHandling'),
    intake: {
      driver: mech(i, 'driver', w, names), metersPerRotation: num(i, 'metersPerRotation', w), travel: num(i, 'travel', w),
      slideAxis: vec3(i.slideAxis, `${w}.slideAxis`),
      openBox: { center: vec3(box.center, `${w}.openBox.center`), half: vec3(box.half, `${w}.openBox.half`) },
      minExtension: num(i, 'minExtension', w), roller: mech(i, 'roller', w, names), rollerRadius: num(i, 'rollerRadius', w),
      rollerDirection: sign(i, 'rollerDirection', w), minRollerRps: num(i, 'minRollerRps', w), maxRelativeSpeed: num(i, 'maxRelativeSpeed', w),
    },
    stages: stages.map((x, k) => {
      const o = obj(x, `ballHandling.stages[${k}]`)
      const ww = `ballHandling.stages[${k}]`
      const drivers = o.drivers
      if (!Array.isArray(drivers) || drivers.length === 0) throw new Error(`robot definition: ${ww}.drivers must be a list`)
      return {
        name: str(o, 'name', ww),
        length: num(o, 'length', ww),
        drivers: drivers.map((d, j) => { const dd = obj(d, `${ww}.drivers[${j}]`); const w2 = `${ww}.drivers[${j}]`; return { driver: mech(dd, 'driver', w2, names), direction: sign(dd, 'direction', w2), radius: num(dd, 'radius', w2) } }),
      }
    }),
    beams: beams.map((x, k) => { const o = obj(x, `ballHandling.beams[${k}]`); return { name: str(o, 'name', `ballHandling.beams[${k}]`), position: num(o, 'position', `ballHandling.beams[${k}]`) } }),
    shooter: {
      turret: mech(sh, 'turret', s, names), hood: mech(sh, 'hood', s, names), flywheel: mech(sh, 'flywheel', s, names),
      axis: [axis[0] as number, axis[1] as number], exitForward: num(sh, 'exitForward', s), exitHeight: num(sh, 'exitHeight', s),
      wheelRadius: num(sh, 'wheelRadius', s), efficiency: num(sh, 'efficiency', s), elevationAtHoodZeroDeg: num(sh, 'elevationAtHoodZeroDeg', s),
      hoodDegPerRotation: num(sh, 'hoodDegPerRotation', s), backspin: num(sh, 'backspin', s), minFeedSpeed: num(sh, 'minFeedSpeed', s), minFlywheelRps: num(sh, 'minFlywheelRps', s),
    },
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
