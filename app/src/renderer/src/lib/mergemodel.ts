// Merges the meshes of a loaded robot model by material. A CAD export is thousands of small parts (the OffSeason robot: about 10,000), and
// three.js pays one draw call, one matrix update and one frustum test per mesh every frame: at 10,000 meshes the page ran at 38 frames per
// second on an RTX 4050 with the physics idle. Parts of one material that never move relative to each other are drawn as a single mesh with
// the same triangles, so the picture is unchanged and the draw calls drop to about the number of materials.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export interface MergeResult { meshesBefore: number; meshesAfter: number }

/** Attributes that survive a merge: every part of a material group must have the same set, so the set is the common part. */
const KEEP = ['position', 'normal', 'uv', 'color']

function bake(mesh: THREE.Mesh, toRoot: THREE.Matrix4): THREE.BufferGeometry {
  const g = mesh.geometry.clone()
  const m = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld)
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  g.applyMatrix4(m)
  // a mirrored part (negative determinant) is drawn with flipped winding by three.js; once baked into the geometry the winding must be flipped by hand
  if (m.determinant() < 0) {
    if (g.index) {
      const a = g.index.array as Uint16Array | Uint32Array
      for (let i = 0; i + 2 < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t }
    } else {
      for (const name of Object.keys(g.attributes)) {
        const at = g.getAttribute(name) as THREE.BufferAttribute
        const n = at.itemSize
        for (let i = 0; i + 2 < at.count; i += 3) for (let k = 0; k < n; k++) {
          const x = at.getComponent(i + 1, k); at.setComponent(i + 1, k, at.getComponent(i + 2, k)); at.setComponent(i + 2, k, x)
        }
      }
    }
  }
  return g
}

/**
 * Replaces the meshes under `root` (not skinned, not instanced) by one mesh per material, in root's own coordinates. Meshes with several
 * materials, morph targets or custom attributes are left as they are. Returns the mesh counts before and after.
 */
export function mergeByMaterial(root: THREE.Object3D): MergeResult {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const groups = new Map<THREE.Material, THREE.Mesh[]>()
  let before = 0
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return
    before++
    const m = o as THREE.Mesh
    if ((m as unknown as THREE.SkinnedMesh).isSkinnedMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return
    if (Array.isArray(m.material) || m.geometry.morphAttributes.position) return
    const list = groups.get(m.material)
    if (list) list.push(m); else groups.set(m.material, [m])
  })

  let merged = 0
  const made: THREE.Mesh[] = []
  for (const [material, meshes] of groups) {
    if (meshes.length < 2) continue
    const parts = meshes.map((m) => bake(m, toRoot))
    // common attribute set, and one indexing for all parts
    const common = KEEP.filter((n) => parts.every((p) => p.getAttribute(n)))
    for (const p of parts) for (const n of Object.keys(p.attributes)) if (!common.includes(n)) p.deleteAttribute(n)
    const allIndexed = parts.every((p) => p.index)
    const same = allIndexed || parts.every((p) => !p.index)
    const flat = same ? parts : parts.map((p) => (p.index ? p.toNonIndexed() : p))
    const geometry = mergeGeometries(flat, false)
    for (const p of parts) p.dispose()
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = meshes[0].name ? `${meshes[0].name} (+${meshes.length - 1})` : 'merged'
    mesh.matrixAutoUpdate = false
    made.push(mesh)
    for (const m of meshes) { m.removeFromParent(); m.geometry.dispose() }
    merged += meshes.length
  }
  for (const m of made) root.add(m)
  // parts whose group is now empty add nothing but a node to walk each frame
  const prune = (o: THREE.Object3D): void => {
    for (const c of [...o.children]) prune(c)
    if (o !== root && o.children.length === 0 && !(o as THREE.Mesh).isMesh && !(o as THREE.Light).isLight) o.removeFromParent()
  }
  prune(root)
  let after = 0
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) after++ })
  void merged
  return { meshesBefore: before, meshesAfter: after }
}
