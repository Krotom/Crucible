// Draws the simulated AprilTag camera in the 3D view: every tag on the field (green when the camera sees it), the camera's view cone, lines to the seen tags,
// and the pose the vision pipeline reports (an amber marker, joined to the true position so the error is visible).
import * as THREE from 'three'
import type { VisionInfo } from '../../../engine/protocol'
import { cameraPose, DEFAULT_CAMERA, TAGS } from '../../../engine/vision'
import type { SceneView } from './scene'

const SEEN = 0x3ddc84, UNSEEN = 0x6b7280, EST = 0xffb020

export class VisionOverlay {
  private group = new THREE.Group()
  private tagMeshes = new Map<number, THREE.Mesh>()
  private cone: THREE.LineSegments
  private rays: THREE.LineSegments
  private est: THREE.Mesh
  private err: THREE.Line
  on = true

  constructor(private view: SceneView) {
    for (const t of TAGS) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), new THREE.MeshBasicMaterial({ color: UNSEEN, side: THREE.DoubleSide }))
      // a plane faces +z: turn it about Y to face +x, then about Z to face along the tag's direction
      m.rotation.order = 'ZYX'; m.rotation.set(0, Math.PI / 2, t.facing)
      const pivot = new THREE.Group()
      pivot.position.set(t.x, t.y, t.z)
      pivot.add(m)
      this.group.add(pivot)
      this.tagMeshes.set(t.id, m)
    }
    this.cone = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.6 }))
    this.rays = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SEEN }))
    this.est = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 12), new THREE.MeshBasicMaterial({ color: EST, transparent: true, opacity: 0.85 }))
    this.est.rotation.order = 'ZYX'
    this.err = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: EST }))
    for (const o of [this.cone, this.rays, this.err]) o.frustumCulled = false
    this.group.add(this.cone, this.rays, this.est, this.err)
    this.group.visible = false
  }

  start(): void { this.view.scene.add(this.group) }
  stop(): void { this.view.scene.remove(this.group); this.group.visible = false }

  update(v: VisionInfo | undefined): void {
    const show = this.on && !!v && v.enabled && !!v.truth
    this.group.visible = show
    if (!show || !v || !v.truth) return
    const seen = new Set(v.tags.map((d) => d.id))
    for (const [id, m] of this.tagMeshes) (m.material as THREE.MeshBasicMaterial).color.setHex(seen.has(id) ? SEEN : UNSEEN)
    const c = cameraPose(v.truth, DEFAULT_CAMERA)
    const cam = new THREE.Vector3(c.x, c.y, c.z)
    // the view cone: four edges out to the maximum range
    const h = (DEFAULT_CAMERA.hfovDeg / 2) * Math.PI / 180, vf = (DEFAULT_CAMERA.vfovDeg / 2) * Math.PI / 180, p = DEFAULT_CAMERA.pitchDeg * Math.PI / 180, r = DEFAULT_CAMERA.maxRange
    const edge = (sy: number, sp: number): THREE.Vector3 => {
      const yaw = c.yaw + sy * h, pitch = p + sp * vf
      return new THREE.Vector3(c.x + r * Math.cos(pitch) * Math.cos(yaw), c.y + r * Math.cos(pitch) * Math.sin(yaw), c.z + r * Math.sin(pitch))
    }
    const corners = [edge(1, 1), edge(-1, 1), edge(-1, -1), edge(1, -1)]
    const pts: THREE.Vector3[] = []
    corners.forEach((k, i) => { pts.push(cam, k, k, corners[(i + 1) % 4]) })
    this.cone.geometry.setFromPoints(pts)
    const ray: THREE.Vector3[] = []
    for (const d of v.tags) { const t = TAGS.find((x) => x.id === d.id); if (t) ray.push(cam, new THREE.Vector3(t.x, t.y, t.z)) }
    this.rays.geometry.setFromPoints(ray)
    this.est.visible = this.err.visible = !!v.pose
    if (v.pose) {
      this.est.position.set(v.pose.x, v.pose.y, 0.25)
      this.est.rotation.set(0, 0, v.pose.yaw - Math.PI / 2) // the cone's axis is +y, so this points its tip along the heading
      this.err.geometry.setFromPoints([new THREE.Vector3(v.truth.x, v.truth.y, 0.25), new THREE.Vector3(v.pose.x, v.pose.y, 0.25)])
    }
  }
}
