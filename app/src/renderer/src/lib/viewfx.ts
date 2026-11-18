// Extras drawn over the 3D field: camera presets (including chase and follow cameras), the rules zones, the robot's trail, the arcs and landing
// spots of shots, and a ruler. They live in their own group, which comes and goes with the simulation.
import * as THREE from 'three'
import type { FieldDefinition, RenderFrame } from '../../../engine/types'
import { ALLIANCE_ZONE_DEPTH, CENTER_LINE } from '../../../games/rebuilt'
import type { MatchRecorder, Shot } from './analysis'
import type { SceneView } from './scene'

export type CameraPreset = 'overview' | 'top' | 'driver' | 'follow' | 'blue-hub' | 'red-hub'
export const CAMERA_PRESETS: { id: CameraPreset; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'top', label: 'Top-down' }, { id: 'driver', label: 'Driver (chase)' },
  { id: 'follow', label: 'Follow robot' }, { id: 'blue-hub', label: 'Blue HUB' }, { id: 'red-hub', label: 'Red HUB' },
]

const TRAIL_EVERY = 0.05 // s of sim time between trail points
const TRAIL_MAX = 1200 // points kept (60 s)
const ARC_SHOW = 4 // s after a launch the arc stays drawn
const MARKERS_MAX = 150
const G = 9.81

export function nextPreset(p: CameraPreset, dir: 1 | -1 = 1): CameraPreset {
  const i = CAMERA_PRESETS.findIndex((x) => x.id === p)
  return CAMERA_PRESETS[(i + dir + CAMERA_PRESETS.length) % CAMERA_PRESETS.length].id
}

/** Points of the no-drag ballistic arc of a launch (x, y, z each), from the launch to the floor. */
export function arcPoints(s: Pick<Shot, 'x' | 'y' | 'z' | 'vx' | 'vy' | 'vz'>, n = 24): number[] {
  const flight = Math.max(0.05, (s.vz + Math.sqrt(Math.max(0, s.vz * s.vz + 2 * G * Math.max(s.z, 0)))) / G)
  const out: number[] = []
  for (let i = 0; i <= n; i++) {
    const t = (flight * i) / n
    out.push(s.x + s.vx * t, s.y + s.vy * t, Math.max(0, s.z + s.vz * t - 0.5 * G * t * t))
  }
  return out
}

const COLORS = { scored: 0x5bd490, missed: 0xff6b5e, pending: 0xe6a50a }

export class ViewFx {
  private group = new THREE.Group()
  private field: FieldDefinition | null = null
  private rules = new THREE.Group()
  private trail: THREE.Line
  private trailPts: number[] = []
  private lastTrail = -Infinity
  private arcs = new Map<string, THREE.Line>()
  private markers = new Map<string, THREE.Mesh>()
  private rulerGroup = new THREE.Group()
  private rulerPts: THREE.Vector3[] = []
  private rulerOn = false
  private rulerLine: THREE.Line | null = null
  private down: { x: number; y: number } | null = null
  preset: CameraPreset = 'overview'
  show = { rules: false, trail: false, arcs: true }

  constructor(private view: SceneView, private label: HTMLElement) {
    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe6a50a, transparent: true, opacity: 0.85 }))
    this.trail.frustumCulled = false
    this.trail.visible = false
    this.group.add(this.rules, this.trail, this.rulerGroup)
    const dom = view.renderer.domElement
    dom.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY } })
    dom.addEventListener('pointerup', (e) => {
      const d = this.down; this.down = null
      if (!this.rulerOn || !d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
      this.rulerClick(e)
    })
  }

  /** The sim started (or restarted): draw the effects for this field. */
  start(field: FieldDefinition, gameId: string): void {
    this.stop()
    this.field = field
    this.view.scene.add(this.group)
    this.buildRules(field, gameId)
    this.apply()
    this.setPreset(this.preset)
  }

  stop(): void {
    this.view.scene.remove(this.group)
    this.clearTrail()
    for (const l of this.arcs.values()) this.group.remove(l)
    for (const m of this.markers.values()) this.group.remove(m)
    this.arcs.clear(); this.markers.clear()
    this.clearRuler()
    this.view.controls.enabled = true
    this.field = null
  }

  /** Applies the toggles. */
  apply(): void {
    this.rules.visible = this.show.rules
    this.trail.visible = this.show.trail
    for (const l of this.arcs.values()) l.visible = this.show.arcs
    for (const m of this.markers.values()) m.visible = this.show.arcs
  }

  private buildRules(field: FieldDefinition, gameId: string): void {
    this.rules.clear()
    const L = field.length, W = field.width
    const quad = (x0: number, x1: number, color: number, opacity: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, W), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }))
      m.position.set((x0 + x1) / 2, W / 2, 0.006)
      return m
    }
    const line = (x: number, color: number): THREE.Line => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, 0.012), new THREE.Vector3(x, W, 0.012)]), new THREE.LineBasicMaterial({ color }))
    if (gameId === 'game-rebuilt') {
      this.rules.add(quad(0, ALLIANCE_ZONE_DEPTH, 0x4cc2ff, 0.14), quad(L - ALLIANCE_ZONE_DEPTH, L, 0xff5566, 0.14), line(ALLIANCE_ZONE_DEPTH, 0x4cc2ff), line(L - ALLIANCE_ZONE_DEPTH, 0xff5566), line(CENTER_LINE, 0xffffff))
    } else {
      this.rules.add(line(L / 2, 0xffffff))
    }
  }

  // ---------------------------------------------------------------- cameras

  setPreset(p: CameraPreset): void {
    this.preset = p
    const f = this.field
    const c = this.view.controls, cam = this.view.camera
    c.enabled = p !== 'driver'
    if (!f) return
    const L = f.length, W = f.width
    if (p === 'overview') { c.target.set(L / 2, W / 2, 0); cam.position.set(L / 2, -W * 0.9, W * 1.1) }
    else if (p === 'top') {
      const t = Math.tan((cam.fov * Math.PI) / 360)
      const h = Math.max(W / 2 / t, L / 2 / (t * Math.max(cam.aspect, 0.5))) * 1.08
      c.target.set(L / 2, W / 2, 0); cam.position.set(L / 2, W / 2 - 0.02, h)
    } else if (p === 'blue-hub' || p === 'red-hub') {
      const side = p === 'blue-hub' ? 'blue' : 'red'
      const s = f.sensors.find((x) => x.alliance === side)
      const hx = s ? s.center[0] : side === 'blue' ? L * 0.25 : L * 0.75, hy = s ? s.center[1] : W / 2
      const dir = hx < L / 2 ? 1 : -1
      c.target.set(hx, hy, 1.2); cam.position.set(hx + dir * 5.5, hy - 3.5, 3.2)
    }
    c.update()
  }

  cyclePreset(dir: 1 | -1 = 1): CameraPreset { this.setPreset(nextPreset(this.preset, dir)); return this.preset }

  private yawOf(): number { return new THREE.Euler().setFromQuaternion(this.view.robotObject.quaternion, 'ZYX').z }

  // ---------------------------------------------------------------- per frame

  update(f: RenderFrame, rec: MatchRecorder): void {
    if (!this.field) return
    const r = this.view.robotObject.position
    const cam = this.view.camera, c = this.view.controls
    if (this.preset === 'follow') {
      const d = new THREE.Vector3(r.x - c.target.x, r.y - c.target.y, 0)
      c.target.add(d); cam.position.add(d)
      c.update()
    } else if (this.preset === 'driver') {
      const yaw = this.yawOf(), fx = Math.cos(yaw), fy = Math.sin(yaw)
      cam.position.set(r.x - fx * 2.8, r.y - fy * 2.8, 1.7)
      c.target.set(r.x + fx * 3, r.y + fy * 3, 0.3)
      cam.lookAt(c.target)
    }
    this.updateShots(f, rec)
    this.updateRulerLabel()
  }

  /** Adds a trail point; called for every frame the worker sends, so a slow screen does not thin the trail out. */
  sampleTrail(f: RenderFrame): void {
    if (f.time < this.lastTrail - 1e-9) this.clearTrail()
    if (f.time - this.lastTrail < TRAIL_EVERY) return
    this.lastTrail = f.time
    this.trailPts.push(f.robot[0], f.robot[1], 0.03)
    if (this.trailPts.length > TRAIL_MAX * 3) this.trailPts.splice(0, this.trailPts.length - TRAIL_MAX * 3)
    this.trail.geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.trailPts, 3))
    this.trail.geometry.setDrawRange(0, this.trailPts.length / 3)
  }

  private clearTrail(): void {
    this.trailPts = []
    this.lastTrail = -Infinity
    this.trail.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
  }

  get trailLength(): number { return this.trailPts.length / 3 }

  private updateShots(f: RenderFrame, rec: MatchRecorder): void {
    const live = new Set<string>()
    for (const s of rec.shots) {
      const key = `${s.id}@${s.t}`
      const color = COLORS[s.result]
      const age = f.time - s.t
      if (age >= 0 && age <= ARC_SHOW) {
        live.add(key)
        let line = this.arcs.get(key)
        if (!line) {
          line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(arcPoints(s), 3)), new THREE.LineBasicMaterial({ color, transparent: true }))
          line.frustumCulled = false
          line.visible = this.show.arcs
          this.group.add(line)
          this.arcs.set(key, line)
        }
        const mat = line.material as THREE.LineBasicMaterial
        mat.color.setHex(color)
        mat.opacity = Math.max(0.15, 1 - age / ARC_SHOW)
      }
      if (s.result !== 'pending') {
        let m = this.markers.get(key)
        if (!m) {
          m = new THREE.Mesh(new THREE.CircleGeometry(0.16, 20), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }))
          m.position.set(s.landX, s.landY, 0.02)
          m.visible = this.show.arcs
          this.group.add(m)
          this.markers.set(key, m)
        }
        ;(m.material as THREE.MeshBasicMaterial).color.setHex(color)
      }
    }
    for (const [k, l] of this.arcs) if (!live.has(k)) { this.group.remove(l); l.geometry.dispose(); this.arcs.delete(k) }
    const keys = new Set(rec.shots.map((s) => `${s.id}@${s.t}`))
    for (const [k, m] of this.markers) if (!keys.has(k)) { this.group.remove(m); this.markers.delete(k) }
    while (this.markers.size > MARKERS_MAX) { const k = this.markers.keys().next().value as string; this.group.remove(this.markers.get(k)!); this.markers.delete(k) }
  }

  get arcCount(): number { return this.arcs.size }
  get markerCount(): number { return this.markers.size }

  // ---------------------------------------------------------------- ruler

  setRuler(on: boolean): void {
    this.rulerOn = on
    this.view.renderer.domElement.style.cursor = on ? 'crosshair' : ''
    if (!on) this.clearRuler()
  }
  get rulerActive(): boolean { return this.rulerOn }

  /** Metres between the two measured points, or null while fewer than two are set. */
  get rulerDistance(): number | null { return this.rulerPts.length === 2 ? this.rulerPts[0].distanceTo(this.rulerPts[1]) : null }

  /** Sets a ruler point straight from field coordinates (the pointer path computes the same thing from a click). */
  addRulerPoint(x: number, y: number): void {
    if (this.rulerPts.length >= 2) this.clearRuler()
    this.rulerPts.push(new THREE.Vector3(x, y, 0.03))
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    dot.position.set(x, y, 0.05)
    this.rulerGroup.add(dot)
    if (this.rulerPts.length === 2) {
      this.rulerLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.rulerPts), new THREE.LineBasicMaterial({ color: 0xffffff }))
      this.rulerGroup.add(this.rulerLine)
    }
    this.updateRulerLabel()
  }

  private rulerClick(e: PointerEvent): void {
    const dom = this.view.renderer.domElement
    const r = dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.view.camera)
    const hit = new THREE.Vector3()
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit)) this.addRulerPoint(hit.x, hit.y)
  }

  clearRuler(): void {
    this.rulerPts = []
    this.rulerGroup.clear()
    this.rulerLine = null
    this.label.hidden = true
  }

  private updateRulerLabel(): void {
    const d = this.rulerDistance
    if (d === null) { this.label.hidden = this.rulerPts.length === 0 ? true : this.label.hidden; if (this.rulerPts.length === 1) { this.label.hidden = false; this.place(this.rulerPts[0], 'click a second point') } return }
    const mid = this.rulerPts[0].clone().add(this.rulerPts[1]).multiplyScalar(0.5)
    this.label.hidden = false
    this.place(mid, `${d.toFixed(2)} m`)
  }

  private place(p: THREE.Vector3, text: string): void {
    const v = p.clone().project(this.view.camera)
    const dom = this.view.renderer.domElement
    const behind = v.z > 1
    this.label.style.left = `${((v.x + 1) / 2) * dom.clientWidth}px`
    this.label.style.top = `${((1 - v.y) / 2) * dom.clientHeight}px`
    this.label.style.visibility = behind ? 'hidden' : 'visible'
    if (this.label.textContent !== text) this.label.textContent = text
  }
}
