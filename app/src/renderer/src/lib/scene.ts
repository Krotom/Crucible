// Three.js scene in WPILib coordinates (Z up, +X forward, field origin at a corner), so poses apply without conversion.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

export const FIELD_LENGTH = 16.541 // m, placeholder until the game module supplies the real field (M6)
export const FIELD_WIDTH = 8.069

export class SceneView {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200)
  readonly controls: OrbitControls
  private robot = new THREE.Group()
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
    this.scene.add(floor)
    const grid = new THREE.GridHelper(Math.max(FIELD_LENGTH, FIELD_WIDTH) * 2, Math.round(Math.max(FIELD_LENGTH, FIELD_WIDTH) * 2), 0x2d343d, 0x232830)
    grid.rotation.x = Math.PI / 2
    grid.position.set(FIELD_LENGTH / 2, FIELD_WIDTH / 2, 0)
    this.scene.add(grid)
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0.002), new THREE.Vector3(FIELD_LENGTH, 0, 0.002),
        new THREE.Vector3(FIELD_LENGTH, FIELD_WIDTH, 0.002), new THREE.Vector3(0, FIELD_WIDTH, 0.002),
      ]),
      new THREE.LineBasicMaterial({ color: 0x5b6573 }),
    )
    this.scene.add(outline)
    this.scene.add(new THREE.AxesHelper(0.8))
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
