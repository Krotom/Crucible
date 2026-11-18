// Merging the parts of a robot model by material (renderer/lib/mergemodel.ts): fewer meshes, the same triangles in the same places.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { mergeByMaterial } from '../src/renderer/src/lib/mergemodel'

function bounds(root: THREE.Object3D): THREE.Box3 { return new THREE.Box3().setFromObject(root) }
function triangles(root: THREE.Object3D): number {
  let n = 0
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) n += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3 })
  return n
}
function drawCalls(root: THREE.Object3D): number { let n = 0; root.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++ }); return n }

describe('mergeByMaterial', () => {
  it('draws many parts of one material as one mesh, in the same place', () => {
    const root = new THREE.Group()
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 })
    const blue = new THREE.MeshStandardMaterial({ color: 0x0000ff })
    for (let i = 0; i < 50; i++) {
      const g = new THREE.Group()
      g.position.set(i * 0.1, 0, 0.2)
      g.rotation.z = i * 0.05
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), i % 5 === 0 ? blue : red)
      m.position.set(0, 0.1, 0)
      g.add(m)
      root.add(g)
    }
    root.position.set(3, 1, 0) // the root's own transform is not baked in: the merged mesh lives in root coordinates
    root.updateMatrixWorld(true)
    const before = { box: bounds(root), tris: triangles(root) }
    const r = mergeByMaterial(root)
    root.updateMatrixWorld(true)
    expect(r.meshesBefore).toBe(50)
    expect(r.meshesAfter).toBe(2)
    expect(drawCalls(root)).toBe(2)
    expect(triangles(root)).toBe(before.tris)
    const after = bounds(root)
    for (const k of ['x', 'y', 'z'] as const) { expect(after.min[k]).toBeCloseTo(before.box.min[k], 5); expect(after.max[k]).toBeCloseTo(before.box.max[k], 5) }
  })

  it('keeps a mirrored part facing outward and mixes indexed with non-indexed parts', () => {
    const root = new THREE.Group()
    const mat = new THREE.MeshStandardMaterial()
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).toNonIndexed(), mat)
    b.scale.set(-1, 1, 1)
    b.position.set(5, 0, 0)
    root.add(a, b)
    mergeByMaterial(root)
    expect(drawCalls(root)).toBe(1)
    const mesh = root.children[0] as THREE.Mesh
    // every triangle's geometric normal must point away from the centre of its own part
    const pos = mesh.geometry.getAttribute('position')
    const idx = mesh.geometry.index
    const get = (i: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i) : i)
    const count = idx ? idx.count : pos.count
    let inward = 0
    for (let i = 0; i + 2 < count; i += 3) {
      const p0 = get(i), p1 = get(i + 1), p2 = get(i + 2)
      const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0))
      const centroid = new THREE.Vector3().add(p0).add(p1).add(p2).multiplyScalar(1 / 3)
      const centre = new THREE.Vector3(centroid.x > 2.5 ? 5 : 0, 0, 0)
      if (n.dot(centroid.clone().sub(centre)) < 0) inward++
    }
    expect(inward).toBe(0)
  })

  it('leaves a lone mesh, a skinned mesh and a multi-material mesh alone', () => {
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()))
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()])
    root.add(multi)
    const r = mergeByMaterial(root)
    expect(r.meshesBefore).toBe(2)
    expect(r.meshesAfter).toBe(2)
  })
})
