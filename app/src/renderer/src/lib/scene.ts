// Three.js scene in WPILib coordinates (Z up, +X forward, field origin at a corner), so poses apply without conversion.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { FieldDefinition, PieceSpec, RenderFrame } from '../../../engine/types'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

export const FIELD_LENGTH = 16.541 // m, placeholder until the game module supplies the real field (M6)
export const FIELD_WIDTH = 8.069

export class SceneView {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200)
  readonly controls: OrbitControls
  private base = new THREE.Group()
  private robot = new THREE.Group()
  private simGroup: THREE.Group | null = null
  private pieceMeshes: THREE.InstancedMesh[] = []
  private otherMeshes: THREE.Group[] = []
  private otherHalfZ: number[] = []
  private robotBox: THREE.LineSegments | null = null
  private captureBox: THREE.LineSegments | null = null
  private components: THREE.Group[] = []
  private ro: ResizeObserver

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    host.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color(0x101216)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303338, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(6, -8, 12)
    this.scene.add(sun)

    this.scene.add(this.base)
    this.addField()
    this.scene.add(this.robot)

    this.camera.position.set(FIELD_LENGTH / 2 - 3, -7, 6)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(FIELD_LENGTH / 2, FIELD_WIDTH / 2, 0)
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02
    this.controls.update()

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
  }

  private addField(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_LENGTH, FIELD_WIDTH),
      new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 1 }),
    )
    floor.position.set(FIELD_LENGTH / 2, FIELD_WIDTH / 2, -0.001)
    this.base.add(floor)
    const grid = new THREE.GridHelper(Math.max(FIELD_LENGTH, FIELD_WIDTH) * 2, Math.round(Math.max(FIELD_LENGTH, FIELD_WIDTH) * 2), 0x2d343d, 0x232830)
    grid.rotation.x = Math.PI / 2
    grid.position.set(FIELD_LENGTH / 2, FIELD_WIDTH / 2, 0)
    this.base.add(grid)
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0.002), new THREE.Vector3(FIELD_LENGTH, 0, 0.002),
        new THREE.Vector3(FIELD_LENGTH, FIELD_WIDTH, 0.002), new THREE.Vector3(0, FIELD_WIDTH, 0.002),
      ]),
      new THREE.LineBasicMaterial({ color: 0x5b6573 }),
    )
    this.base.add(outline)
    this.base.add(new THREE.AxesHelper(0.8))
  }

  /** Loads model.glb (chassis) and model_N.glb (components) from /model, the AdvantageScope layout. Returns a status line. */
  async loadRobotModel(): Promise<string> {
    const loader = new GLTFLoader()
    const load = (file: string): Promise<THREE.Group> => loader.loadAsync(`/model/${file}`).then((g) => g.scene)
    let info: { components?: unknown[] } = {}
    try {
      const cfg = await fetch('/model/config.json')
      if (!cfg.ok) return 'No robot model found (set CRUCIBLE_MODEL_DIR or crucible.config.json).'
      info = await cfg.json()
    } catch { return 'No robot model found.' }
    const body = await load('model.glb')
    this.robot.add(body)
    const n = info.components?.length ?? 0
    for (let i = 0; i < n; i++) {
      const holder = new THREE.Group()
      try { holder.add(await load(`model_${i}.glb`)) } catch { /* component without a model */ }
      this.robot.add(holder)
      this.components.push(holder)
    }
    return `Robot model loaded (${n} components).`
  }

  /** Pose2d as [x, y, rotationRadians]. */
  setRobotPose2d(p: ArrayLike<number>): void {
    this.robot.position.set(p[0], p[1], 0)
    this.robot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), p[2])
  }

  /** Pose3d as [x, y, z, qw, qx, qy, qz]. */
  setRobotPose3d(p: ArrayLike<number>): void {
    this.robot.position.set(p[0], p[1], p[2])
    this.robot.quaternion.set(p[4], p[5], p[6], p[3])
  }

  /** Robot-relative Pose3d array, one per component model. Components with no data keep their last pose. */
  setComponentPoses(flat: ArrayLike<number> | undefined): void {
    this.components.forEach((c, i) => {
      if (!flat || flat.length < (i + 1) * 7) { c.position.set(0, 0, 0); c.quaternion.identity(); return }
      const o = i * 7
      c.position.set(flat[o], flat[o + 1], flat[o + 2])
      c.quaternion.set(flat[o + 4], flat[o + 5], flat[o + 6], flat[o + 3])
    })
  }

  get componentCount(): number { return this.components.length }

  /** Replaces the placeholder field with a game module's field: colliders, sensors, and instanced game pieces. */
  setSimField(field: FieldDefinition, pieces: PieceSpec[], robotHalf: [number, number, number], othersHalf: [number, number, number][] = []): void {
    this.clearSim()
    this.base.visible = false
    const g = new THREE.Group()
    for (const b of field.colliders) {
      const isFloor = b.label === 'floor'
      const mesh = new THREE.Mesh(
        b.hull ? new ConvexGeometry(b.hull.map((p) => new THREE.Vector3(p[0], p[1], p[2]))) : new THREE.BoxGeometry(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2),
        new THREE.MeshStandardMaterial({ color: isFloor ? 0x1b2027 : b.robotPass ? 0x6a5a2a : 0x55606e, roughness: 0.9, transparent: !isFloor, opacity: isFloor ? 1 : 0.7 }),
      )
      if (!b.hull) {
        mesh.position.set(b.center[0], b.center[1], b.center[2])
        mesh.rotation.z = b.yaw ?? 0
      }
      g.add(mesh)
    }
    for (const sn of field.sensors) {
      const geo = new THREE.BoxGeometry(sn.half[0] * 2, sn.half[1] * 2, sn.half[2] * 2)
      const color = sn.alliance === 'red' ? 0xff5566 : sn.alliance === 'blue' ? 0x4cc2ff : 0x7bed9f
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }))
      const w = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color }))
      for (const o of [m, w]) { o.position.set(sn.center[0], sn.center[1], sn.center[2]); o.rotation.z = sn.yaw ?? 0; g.add(o) }
    }
    const grid = new THREE.GridHelper(Math.max(field.length, field.width) * 2, Math.round(Math.max(field.length, field.width) * 2), 0x2d343d, 0x232830)
    grid.rotation.x = Math.PI / 2
    grid.position.set(field.length / 2, field.width / 2, 0.001)
    g.add(grid)
    for (const spec of pieces) {
      const im = new THREE.InstancedMesh(new THREE.SphereGeometry(spec.radius, 16, 12), new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.6 }), 4000)
      im.count = 0
      im.frustumCulled = false
      g.add(im)
      this.pieceMeshes.push(im)
    }
    // other robots: red boxes with a nose mark on the front
    this.otherHalfZ = othersHalf.map((h) => h[2])
    this.otherMeshes = othersHalf.map((h) => {
      const box = new THREE.Mesh(new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2), new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7, transparent: true, opacity: 0.85 }))
      const holder = new THREE.Group()
      box.position.z = h[2]
      const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, h[1] * 1.2, 0.04), new THREE.MeshBasicMaterial({ color: 0xffd166 }))
      nose.position.set(h[0], 0, h[2] * 2)
      holder.add(box, nose)
      g.add(holder)
      return holder
    })
    this.scene.add(g)
    this.simGroup = g
    // the actual collision box of the robot, for checking it against the model
    this.robotBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(robotHalf[0] * 2, robotHalf[1] * 2, robotHalf[2] * 2)),
      new THREE.LineBasicMaterial({ color: 0xff9f43 }),
    )
    this.robotBox.position.z = 0
    this.robot.add(this.robotBox)
    // the intake capture volume, drawn in the world (green while it is catching pieces)
    this.captureBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: 0x555d66 }))
    this.captureBox.visible = false
    g.add(this.captureBox)
    this.controls.target.set(field.length / 2, field.width / 2, 0)
    this.camera.position.set(field.length / 2, -field.width * 0.9, field.width * 1.1)
    this.controls.update()
  }

  clearSim(): void {
    if (this.simGroup) { this.scene.remove(this.simGroup); this.simGroup = null }
    this.pieceMeshes = []
    this.otherMeshes = []
    if (this.robotBox) { this.robot.remove(this.robotBox); this.robotBox = null }
    this.captureBox = null
    this.base.visible = true
  }

  get simActive(): boolean { return this.simGroup !== null }

  /** Draws one engine frame: robot pose (the robot body origin sits at collider center height, so drop it to the floor) and pieces. */
  setSimFrame(f: RenderFrame, robotHalfZ: number): void {
    this.robot.position.set(f.robot[0], f.robot[1], f.robot[2] - robotHalfZ)
    this.robot.quaternion.set(f.robot[4], f.robot[5], f.robot[6], f.robot[3])
    if (this.robotBox) this.robotBox.position.z = robotHalfZ
    f.others.forEach((o, i) => {
      const m = this.otherMeshes[i]
      if (!m) return
      m.position.set(o[0], o[1], o[2] - (this.otherHalfZ[i] ?? 0))
      m.quaternion.set(o[4], o[5], o[6], o[3])
    })
    if (this.captureBox) {
      const c = f.capture
      this.captureBox.visible = c !== null
      if (c) {
        this.captureBox.position.set(c.center[0], c.center[1], c.center[2])
        this.captureBox.rotation.z = c.yaw
        this.captureBox.scale.set(c.half[0], c.half[1], c.half[2])
        ;(this.captureBox.material as THREE.LineBasicMaterial).color.set(c.active ? 0x7bed9f : 0x555d66)
      }
    }
    const counts = new Array(this.pieceMeshes.length).fill(0)
    const m = new THREE.Matrix4()
    for (let i = 0; i < f.pieceCount; i++) {
      const k = f.pieceSpecIndex[i]
      const im = this.pieceMeshes[k]
      if (!im || counts[k] >= im.instanceMatrix.count) continue
      m.makeTranslation(f.piecePositions[i * 3], f.piecePositions[i * 3 + 1], f.piecePositions[i * 3 + 2])
      im.setMatrixAt(counts[k]++, m)
    }
    this.pieceMeshes.forEach((im, k) => { im.count = counts[k]; im.instanceMatrix.needsUpdate = true })
  }

  /** Moves the orbit target onto the robot, keeping the current viewing offset. */
  focusRobot(): void {
    const delta = this.robot.position.clone().sub(this.controls.target)
    delta.z = 0
    this.controls.target.add(delta)
    this.camera.position.add(delta)
    this.controls.update()
  }

  render(): void { this.renderer.render(this.scene, this.camera) }

  private resize(): void {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }
}
