#!/usr/bin/env node
// Offline pipeline: official REBUILT field GLB (Onshape export, ~70 MB) -> web-light field model for the renderer.
//
//   node tools/build-field.mjs [input.glb] [output dir]
//
// Defaults: input  C:\Users\ProtonMe\Downloads\FE-2026- REBUILT(TM) Playing Field.glb
//           output app/assets/field/   (rebuilt-field.glb + rebuilt-field.json)
//
// What it does (plain node ESM, no dependencies):
//  1. Parses the GLB, walks the node tree, bakes every mesh instance's world matrix.
//  2. Converts to the simulator's WPILib frame: x_w = 8.2705 - x, y_w = 4.0345 - y, z unchanged (rotation by 180 deg about Z
//     plus a translation, so the winding is preserved). Metres, Z-up, origin at the blue-wall corner. The root node is identity.
//  3. Removes FUEL (their centres go to the JSON), fasteners and other tiny parts by name, parts hidden inside the
//     BUMP/HUB/TRENCH shells (not visible), and, as a second rule, any instance whose world bounding-box diagonal is below
//     --min-diag (default 0.05 m) unless it is an AprilTag, tape, or on the keep-list of visible structure.
//  4. Drops TEXCOORD_0, dedupes identical baked geometry, merges by (element, material), welds vertices, quantizes
//     (KHR_mesh_quantization: int16 normalized positions with a per-mesh uniform node scale/translation, int8 normals).
//  5. Writes rebuilt-field.glb and rebuilt-field.json (counts, per-element and per-mesh AABBs in the WPILib frame, AprilTags,
//     the 456 FUEL start positions, HUB funnel profile, BUMP ridge profile) and re-parses its own output to verify it.
//
// Options: --min-diag <m>  --no-quantize  --keep-internal  --keep-wheels  --no-verify
//          --no-simplify  --simplify-error <m> (start tolerance, default 1.5 mm; raised until under --max-tris)  --max-tris <n> (default 600000)
// Simplification uses meshoptimizer's simplifier (already in app/node_modules via @types/three); skipped if it cannot be imported.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_IN = 'C:\\Users\\ProtonMe\\Downloads\\FE-2026- REBUILT\u2122 Playing Field.glb'
const DEFAULT_OUT = path.resolve(HERE, '..', 'assets', 'field')

// ---------------------------------------------------------------------------------------------------------------- args
const argv = process.argv.slice(2)
const opts = { minDiag: 0.05, quantize: true, dropInternal: true, dropWheels: true, verify: true, simplify: true, simplifyError: 0.0015, maxTris: 600000 }
const pos = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--min-diag') opts.minDiag = Number(argv[++i])
  else if (a === '--no-quantize') opts.quantize = false
  else if (a === '--keep-internal') opts.dropInternal = false
  else if (a === '--keep-wheels') opts.dropWheels = false
  else if (a === '--no-verify') opts.verify = false
  else if (a === '--no-simplify') opts.simplify = false
  else if (a === '--simplify-error') opts.simplifyError = Number(argv[++i])
  else if (a === '--max-tris') opts.maxTris = Number(argv[++i])
  else pos.push(a)
}
const inPath = path.resolve(pos[0] ?? DEFAULT_IN)
const outDir = path.resolve(pos[1] ?? DEFAULT_OUT)

// Frame: x_w = FX - x, y_w = FY - y (half the inner field length / width, from the official 16.541 x 8.069 m).
const FX = 8.2705
const FY = 4.0345
const T0 = Date.now()

// ------------------------------------------------------------------------------------------------------------ glb read
function readGlb(file) {
  const buf = readFileSync(file)
  if (buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a GLB: ' + file)
  const jl = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jl).replace(/\0+$/, '').trim())
  const binStart = 20 + jl + 8
  return { buf, json, binStart }
}
const COMP = { 5120: [1, 'readInt8'], 5121: [1, 'readUInt8'], 5122: [2, 'readInt16LE'], 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] }
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
function accessorReader(g, binBuf, binStart, idx) {
  const a = g.accessors[idx]
  const bv = g.bufferViews[a.bufferView]
  const [size, fn] = COMP[a.componentType]
  const n = NCOMP[a.type]
  const stride = bv.byteStride || size * n
  const base = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0)
  return { count: a.count, n, get: (i, c) => binBuf[fn](base + i * stride + c * size), a }
}

// --------------------------------------------------------------------------------------------------------- matrix utils
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mul(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s }
  return o
}
// frame change as a matrix: (x,y,z) -> (FX - x, FY - y, z)
const FRAME = [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, FX, FY, 0, 1]
function det3(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
}
function normalMatrix(m) { // inverse transpose of the upper 3x3, row-major result n[r*3+c]
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10]
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g)
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d
  const det = a * A + b * B + c * C
  const k = 1 / det
  return [A * k, B * k, C * k, D * k, E * k, F * k, G * k, H * k, I * k]
}

// -------------------------------------------------------------------------------------------------------------- parse
const { buf, json: g, binStart } = readGlb(inPath)
const N = g.nodes
const log = (...a) => console.log(...a)
log(`input  ${inPath}  (${(buf.length / 1048576).toFixed(1)} MB), ${N.length} nodes, ${g.meshes.length} meshes`)

// Walk the tree: for each mesh node keep world matrix (source frame), chain of names, level-1 ancestor.
const instances = []
{
  const root = g.scenes[g.scene ?? 0].nodes[0]
  const stack = [{ i: root, M: IDENT, names: [], l1: -1 }]
  while (stack.length) {
    const { i, M, names, l1 } = stack.pop()
    const n = N[i]
    const W = n.matrix ? mul(M, n.matrix) : M
    const nm = n.name || ''
    const chain = names.concat(nm)
    const myL1 = names.length === 1 ? i : l1 // names.length===1 means parent is the root, so this node is level 1
    if (n.mesh !== undefined) instances.push({ node: i, name: nm, chain, l1: myL1, W })
    for (const c of n.children || []) stack.push({ i: c, M: W, names: chain, l1: myL1 })
  }
}
const L1 = new Map() // level-1 node -> info
for (const c of N[g.scenes[g.scene ?? 0].nodes[0]].children) L1.set(c, { name: N[c].name, bbox: null, trisBefore: 0, trisAfter: 0, vertsAfter: 0 })

// ----------------------------------------------------------------------------------------------------------- classify
const stripOcc = (s) => s.replace(/^occurrence of /, '')
// Own-name drops: fasteners, tiny hardware, motors/wheels on the gates, hook tape, seaming tape under the carpet.
const DROP_OWN = [
  /^(PEM |Hex bolt|Socket |Screw_|Flanged Bearing|Hook Tape|Carpet Seaming Tape|Knob|Spacer$|Case$|Diffuser$)/,
  /Rivet/, /Gas Spring/, /^4138T/, /Hinge, Insert/, /Connector Pin/, /Thread/,
  /Counterbalance/, /Hard Stop/, /^FE-00054/
]
const DROP_WHEELS = [/Wheel/, /^REV-21/, /Tread/]
// Ancestor drops: whole assemblies of small hardware.
const DROP_ANC = [/Light Assembly/, /Counterbalance Assy/, /Hard Stop Weldment/, /Gas Spring/, /Trench Arm Pin Assy/, /Trench Pivot Shaft/, /Hinged Riser Sleeve/]
// Parts hidden inside the plastic shells (not visible to a driver or a camera): bump frame, hub frame and fuel counter.
const DROP_INTERNAL = [
  /Bump (Center Rib|Body|Base|Mounting Bulkhead|Socket Bulkhead|Pin)/, /GE-2610[2-9]/,
  /Hub (Crossbar|Brace|Internal Wall|Base|Side Frame|Light Mount|Funnel Base|Ramp)/, /GE-26(301|302|312|314|315|317|331|332|333)/,
  /GE-264\d\d/, /Counter (Side|Top|Bottom|Middle)/, /Fuel Counter/,
  /Trench (Fixed|Hinged) Riser (Inside|Outside) Body/, /GE-2622[12]/, /GE-2620[56]/,
  // welded perimeter: tube frame inside the opaque end panels (FE-00004) and the entry-ramp hinge halves (FE-00014-02)
  /FE-00004/, /FE-00014-02/
]
// Keep-list: visible structure that skips the size rule.
const KEEP = [
  /Hub (Funnel Side|Side Panel|Front Panel|Rear Panel|Roof Panel|Net|Ramp)/, /Hub Side Diffuser|Hub Rear Diffuser/,
  /Trench (Fixed|Hinged) Arm|Trench (Inside|Outside|Side) Skirt|Trench Top|Trench AprilTag Mount/, /Bump Plastic/,
  /Tower (Upright|Rung|Lower Plastic|Upper Plastic|Base)/, /Outpost (Chute|Exchange|Lower Panel|Upper Panel|Floor)/,
  /Driver Station Acrylic|Sponsor Panel|End Panel|Field Top Rail|Field Plastic|Gate Plastic|Field Rail|Outrigger|Entry Ramp|Field Gate/,
  /Depot/
]
function alliance(x) { return x < 0 ? 'red' : 'blue' } // source frame: x < 0 = RED (AprilTag IDs 1-16)

function classify(inst, centreX) {
  const l1name = N[inst.l1].name || ''
  const own = stripOcc(inst.name)
  const below = inst.chain.slice(2).map(stripOcc) // ancestors below the level-1 node, including the node itself
  const all = below.join(' / ')
  const tag = /AprilTag(?:, ID | Vinyl)?/.test(all) ? /ID (\d+)/.exec(all) : null
  const r = { group: 'OTHER', tagId: tag ? Number(tag[1]) : null, drop: null, keep: false }
  if (/Fuel$|: Fuel/.test(l1name) && /Fuel/.test(l1name)) { r.fuel = true; return r }
  if (/Hub|Bump|Trench|Tower|Outpost|Depot/.test(l1name)) {
    const el = /Hub/.test(l1name) ? 'HUB' : /Bump/.test(l1name) ? 'BUMP' : /Trench/.test(l1name) ? 'TRENCH' : /Tower/.test(l1name) ? 'TOWER' : /Outpost/.test(l1name) ? 'OUTPOST' : 'DEPOT'
    r.group = `${el}_${alliance(centreX)}`
  } else if (/Perimeter/.test(l1name)) {
    r.group = /Configurable Guardrail/.test(all) ? 'GUARDRAIL' : `DRIVER_STATION_${alliance(centreX)}`
  } else if (/Carpet/.test(l1name) && !/Seaming/.test(l1name)) r.group = 'CARPET'
  else if (/SCORING TABLE/.test(l1name)) r.group = 'SCORING_TABLE'
  else if (/Gaffer Tape/.test(l1name)) r.group = 'TAPE'
  else if (/Seaming Tape/.test(l1name)) r.group = 'TAPE'
  else r.group = 'OTHER'
  if (/Gaff|Gaffer/.test(all) || /Gaffer Tape/.test(l1name)) r.group = 'TAPE'
  if (r.tagId != null) { r.group = `APRILTAG_${r.tagId}`; r.keep = true; return r }
  if (r.group === 'TAPE') { r.keep = true; if (/Seaming/.test(l1name)) r.drop = 'seaming-tape' ; return r }
  const dropOwn = DROP_OWN.some((re) => re.test(own)) || (opts.dropWheels && DROP_WHEELS.some((re) => re.test(own)))
  if (dropOwn) { r.drop = 'fastener/hardware'; return r }
  if (below.slice(0, -1).some((s) => DROP_ANC.some((re) => re.test(s)))) { r.drop = 'hardware-assembly'; return r }
  if (opts.dropInternal && (DROP_INTERNAL.some((re) => re.test(all)))) { r.drop = 'hidden-internal'; return r }
  r.keep = KEEP.some((re) => re.test(all))
  return r
}

// ------------------------------------------------------------------------------------------ first pass: level-1 bboxes
function accMinMax(a) { return { mn: a.min, mx: a.max } }
function instBoxSrc(inst) { // loose world bbox of an instance in the SOURCE frame (from accessor min/max)
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  const W = inst.W
  for (const p of g.meshes[N[inst.node].mesh].primitives) {
    const { mn, mx } = accMinMax(g.accessors[p.attributes.POSITION])
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? mx[0] : mn[0], y = k & 2 ? mx[1] : mn[1], z = k & 4 ? mx[2] : mn[2]
      const X = W[0] * x + W[4] * y + W[8] * z + W[12], Y = W[1] * x + W[5] * y + W[9] * z + W[13], Z = W[2] * x + W[6] * y + W[10] * z + W[14]
      if (X < bb[0]) bb[0] = X; if (Y < bb[1]) bb[1] = Y; if (Z < bb[2]) bb[2] = Z
      if (X > bb[3]) bb[3] = X; if (Y > bb[4]) bb[4] = Y; if (Z > bb[5]) bb[5] = Z
    }
  }
  inst.box = bb
  inst.diag = Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2])
  return bb
}
for (const inst of instances) {
  const bb = instBoxSrc(inst)
  const e = L1.get(inst.l1)
  if (!e.bbox) e.bbox = bb.slice()
  else for (let k = 0; k < 3; k++) { e.bbox[k] = Math.min(e.bbox[k], bb[k]); e.bbox[k + 3] = Math.max(e.bbox[k + 3], bb[k + 3]) }
}
function meshTris(mi) { let t = 0, v = 0; for (const p of g.meshes[mi].primitives) { t += g.accessors[p.indices].count / 3; v += g.accessors[p.attributes.POSITION].count } return { t, v } }

// ------------------------------------------------------------------------------------------------------- second pass
const mats = g.materials
function matHex(mi) {
  const m = mats[mi]; const c = (m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorFactor) || [1, 1, 1, 1]
  const h = c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
  return c[3] < 0.999 ? `${h}a${Math.round(c[3] * 100)}` : h
}
const buckets = new Map() // key group|mat -> {group, mat, pos[], nor[], idx[]}
const seen = new Set()
const fuel = []
const tags = new Map() // id -> {}
const stat = { dropped: {}, droppedSize: { n: 0, tris: 0, byNames: {} }, dedupe: 0, dropNames: {}, keptNames: {}, keptInst: 0, srcTrisKeptInst: 0 }
const funnel = {} // hub index -> verts [x,y,z] baked
const bumpTris = [] // baked plastic tris of the first bump: {p:[...9]}
let firstBumpL1 = null
const hubIndexOf = (nm) => { const m = /Hub <(\d+)>/.exec(nm); return m ? Number(m[1]) : null }

for (const inst of instances) {
  const e = L1.get(inst.l1)
  const mi = N[inst.node].mesh
  const { t: srcT } = meshTris(mi)
  e.trisBefore += srcT
  const bbc = inst.box
  const cx = (bbc[0] + bbc[3]) / 2
  const centreX = L1.get(inst.l1).bbox ? (e.bbox[0] + e.bbox[3]) / 2 : cx
  const cls = classify(inst, /Perimeter/.test(e.name) ? cx : centreX)
  if (cls.fuel) {
    // centre of the ball in the source frame from the local bbox centre (rigid transform => exact)
    const p = g.meshes[mi].primitives[0]
    const a = g.accessors[p.attributes.POSITION]
    const lc = [(a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, (a.min[2] + a.max[2]) / 2]
    const W = inst.W
    const X = W[0] * lc[0] + W[4] * lc[1] + W[8] * lc[2] + W[12], Y = W[1] * lc[0] + W[5] * lc[1] + W[9] * lc[2] + W[13], Z = W[2] * lc[0] + W[6] * lc[1] + W[10] * lc[2] + W[14]
    const far = Math.abs(X) > 7
    const grp = !far ? 'neutral' : (Z < 0.3 ? 'depot' : 'chute') + '-' + alliance(X)
    fuel.push({ x: FX - X, y: FY - Y, z: Z, group: grp })
    continue
  }
  const isFunnel = /Hub Funnel Side/.test(inst.chain.join('/')) && hubIndexOf(e.name) != null
  const isBumpPlastic = /Bump Plastic/.test(inst.chain.join('/'))
  const wantStats = isFunnel || (isBumpPlastic && (firstBumpL1 == null || firstBumpL1 === inst.l1))
  let drop = cls.drop
  let sizeDrop = false
  if (!drop && !cls.keep && inst.diag < opts.minDiag) { drop = 'size'; sizeDrop = true }
  if (drop && !wantStats) {
    stat.dropped[drop] = stat.dropped[drop] || { n: 0, tris: 0 }
    stat.dropped[drop].n++; stat.dropped[drop].tris += srcT
    { const dn = (stat.dropNames[drop] = stat.dropNames[drop] || {}); const k = stripOcc(inst.name).replace(/<d+>/g, '<n>'); dn[k] = (dn[k] || 0) + 1 }
    if (sizeDrop) { const k = stripOcc(inst.name).replace(/<\d+>/g, '<n>'); stat.droppedSize.byNames[k] = (stat.droppedSize.byNames[k] || 0) + 1 }
    continue
  }
  const M = mul(FRAME, inst.W)
  const flip = det3(M) < 0
  const NM = normalMatrix(M)
  for (const p of g.meshes[mi].primitives) {
    const P = accessorReader(g, buf, binStart, p.attributes.POSITION)
    const Nr = accessorReader(g, buf, binStart, p.attributes.NORMAL)
    const I = accessorReader(g, buf, binStart, p.indices)
    const pos = new Float32Array(P.count * 3), nor = new Float32Array(P.count * 3)
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity, sx = 0, sy = 0, sz = 0
    for (let v = 0; v < P.count; v++) {
      const x = P.get(v, 0), y = P.get(v, 1), z = P.get(v, 2)
      const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14]
      pos[v * 3] = X; pos[v * 3 + 1] = Y; pos[v * 3 + 2] = Z
      if (X < mnx) mnx = X; if (Y < mny) mny = Y; if (Z < mnz) mnz = Z
      if (X > mxx) mxx = X; if (Y > mxy) mxy = Y; if (Z > mxz) mxz = Z
      sx += X; sy += Y; sz += Z
      const nx = Nr.get(v, 0), ny = Nr.get(v, 1), nz = Nr.get(v, 2)
      let a = NM[0] * nx + NM[1] * ny + NM[2] * nz, b = NM[3] * nx + NM[4] * ny + NM[5] * nz, c = NM[6] * nx + NM[7] * ny + NM[8] * nz
      const l = Math.hypot(a, b, c) || 1
      nor[v * 3] = a / l; nor[v * 3 + 1] = b / l; nor[v * 3 + 2] = c / l
    }
    const idx = new Uint32Array(I.count)
    for (let k = 0; k < I.count; k += 3) {
      const a = I.get(k, 0), b = I.get(k + 1, 0), c = I.get(k + 2, 0)
      idx[k] = a; idx[k + 1] = flip ? c : b; idx[k + 2] = flip ? b : c
    }
    if (isFunnel) { const h = hubIndexOf(e.name); (funnel[h] = funnel[h] || []).push(pos) }
    if (isBumpPlastic && (firstBumpL1 == null || firstBumpL1 === inst.l1)) { firstBumpL1 = inst.l1; bumpTris.push({ pos, idx }) }
    if (drop) continue // collected for stats only
    // dedupe identical baked geometry
    const key = `${p.material}|${P.count}|${I.count}|${mnx.toFixed(4)},${mny.toFixed(4)},${mnz.toFixed(4)},${mxx.toFixed(4)},${mxy.toFixed(4)},${mxz.toFixed(4)}|${sx.toFixed(3)},${sy.toFixed(3)},${sz.toFixed(3)}`
    if (seen.has(key)) { stat.dedupe++; continue }
    seen.add(key)
    const bk = `${cls.group}|${p.material}`
    let b = buckets.get(bk)
    if (!b) { b = { group: cls.group, mat: p.material, l1: new Map(), parts: [] }; buckets.set(bk, b) }
    b.parts.push({ pos, nor, idx, l1: inst.l1, nm: `${e.name.replace(/<d+>/g, '<n>').replace(/^occurrence of /, '')} :: ${stripOcc(inst.name).replace(/<d+>/g, '<n>')}` })
    b.l1.set(inst.l1, (b.l1.get(inst.l1) || 0) + idx.length / 3)
    e.trisAfter += idx.length / 3
    { const k = `${e.name.replace(/<d+>/g,'<n>').replace(/^occurrence of /,'')} :: ${stripOcc(inst.name).replace(/<d+>/g, '<n>')}`; stat.keptNames[k] = (stat.keptNames[k] || 0) + idx.length / 3 }
    if (cls.tagId != null) tags.set(cls.tagId, true)
  }
}
log(`pass 2 done in ${((Date.now() - T0) / 1000).toFixed(1)} s; buckets ${buckets.size}, fuel ${fuel.length}`)

// ------------------------------------------------------------------------------------------ simplify (meshoptimizer)
const trisAfterRules = [...L1.values()].reduce((s, e) => s + e.trisAfter, 0)
const simpInfo = { enabled: false, errorMeters: 0, trisBefore: trisAfterRules, trisAfter: trisAfterRules }
if (opts.simplify) {
  let MS = null
  try { MS = (await import('meshoptimizer/simplifier')).MeshoptSimplifier; await MS.ready } catch (e) { log('simplifier unavailable, skipping:', e.message) }
  if (MS && MS.supported) {
    simpInfo.enabled = true
    const exempt = (grp, nm) => /^(TAPE|CARPET|SCORING_TABLE)/.test(grp) || (/^APRILTAG_/.test(grp) && !/Base Poly/.test(nm)) // tag vinyl (the pattern) is never touched
    let err = opts.simplifyError, total = 0
    for (let it = 0; it < 14; it++) {
      total = 0
      for (const b of buckets.values()) for (const part of b.parts) {
        if (exempt(b.group, part.nm) || part.idx.length < 90) { part.idxS = part.idx; total += part.idx.length / 3; continue }
        // never let the tolerance exceed a quarter of the part's thinnest dimension, so thin plastic sheets survive
        if (part.minDim === undefined) { let a = [Infinity, Infinity, Infinity], z = [-Infinity, -Infinity, -Infinity]; for (let v = 0; v < part.pos.length; v += 3) for (let k = 0; k < 3; k++) { const x = part.pos[v + k]; if (x < a[k]) a[k] = x; if (x > z[k]) z[k] = x } part.minDim = Math.max(0.0005, Math.min(z[0] - a[0], z[1] - a[1], z[2] - a[2])) }
        const [res] = MS.simplify(part.idx, part.pos, 3, 0, Math.min(err, 0.25 * part.minDim), ['ErrorAbsolute'])
        part.idxS = res; total += res.length / 3
      }
      log(`simplify error ${(err * 1000).toFixed(1)} mm -> ${total} triangles`)
      if (total <= opts.maxTris) break
      err *= 1.5
    }
    simpInfo.errorMeters = err; simpInfo.trisAfter = total
    for (const e of L1.values()) e.trisAfter = 0
    for (const b of buckets.values()) for (const part of b.parts) L1.get(part.l1).trisAfter += part.idxS.length / 3
  }
}

// ------------------------------------------------------------------------------------------- weld + quantize + emit
const out = { nodes: [], meshes: [], accessors: [], bufferViews: [], materials: [], bins: [] }
const matMap = new Map()
function outMaterial(mi) {
  if (matMap.has(mi)) return matMap.get(mi)
  const m = JSON.parse(JSON.stringify(mats[mi])); delete m.extensions
  const c = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorFactor
  if (c && c[3] < 0.999 && !m.alphaMode) m.alphaMode = 'BLEND'
  out.materials.push(m); matMap.set(mi, out.materials.length - 1); return out.materials.length - 1
}
let binLen = 0
function pushBin(u8) { // 4-byte aligned append, returns offset
  const pad = (4 - (binLen % 4)) % 4
  if (pad) { out.bins.push(Buffer.alloc(pad)); binLen += pad }
  const off = binLen; out.bins.push(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)); binLen += u8.byteLength; return off
}
function addView(u8, target, stride) {
  const off = pushBin(u8)
  const v = { buffer: 0, byteOffset: off, byteLength: u8.byteLength }
  if (stride) v.byteStride = stride
  if (target) v.target = target
  out.bufferViews.push(v); return out.bufferViews.length - 1
}
// mesh name per bucket
const nameFor = new Map(); const used = new Map()
for (const [key, b] of buckets) {
  let nm = b.group.startsWith('APRILTAG_') ? b.group : `${b.group}_${matHex(b.mat)}`
  if (!b.group.startsWith('APRILTAG_')) { if (used.has(nm) && used.get(nm) !== b.mat) nm += `_m${b.mat}`; used.set(nm, b.mat) }
  nameFor.set(key, nm)
}
const meshBuckets = new Map() // mesh name -> buckets
for (const [key, b] of buckets) { const nm = nameFor.get(key); (meshBuckets.get(nm) || meshBuckets.set(nm, []).get(nm)).push(b) }

const meshInfo = [] // json info per mesh
let totV = 0, totT = 0
function dequantBox(c, h, qmn, qmx) { return [0, 1, 2].map((k) => c[k] + (qmn[k] / 32767) * h).concat([0, 1, 2].map((k) => c[k] + (qmx[k] / 32767) * h)) }
for (const [nm, bl] of [...meshBuckets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  // overall bbox of the mesh (all primitives) so that one node transform serves all of them
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (const b of bl) for (const part of b.parts) for (let v = 0; v < part.pos.length; v += 3) for (let k = 0; k < 3; k++) { const x = part.pos[v + k]; if (x < mn[k]) mn[k] = x; if (x > mx[k]) mx[k] = x }
  const c = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2)
  const h = Math.max((mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2, 1e-6)
  const prims = []
  let mv = 0, mt = 0
  const qmnAll = [Infinity, Infinity, Infinity], qmxAll = [-Infinity, -Infinity, -Infinity]
  for (const b of bl) {
    const map = new Map(); const qp = []; const qn = []; const ix = []
    for (const part of b.parts) {
      const pidx = part.idxS || part.idx
      const remap = new Int32Array(part.pos.length / 3).fill(-1)
      for (let q = 0; q < pidx.length; q++) {
        const v = pidx[q]
        if (remap[v] >= 0) continue
        let a, bb, cc, na, nb, nc
        if (opts.quantize) {
          a = Math.round(((part.pos[v * 3] - c[0]) / h) * 32767); bb = Math.round(((part.pos[v * 3 + 1] - c[1]) / h) * 32767); cc = Math.round(((part.pos[v * 3 + 2] - c[2]) / h) * 32767)
          na = Math.round(part.nor[v * 3] * 127); nb = Math.round(part.nor[v * 3 + 1] * 127); nc = Math.round(part.nor[v * 3 + 2] * 127)
        } else {
          a = Math.fround(part.pos[v * 3]); bb = Math.fround(part.pos[v * 3 + 1]); cc = Math.fround(part.pos[v * 3 + 2])
          na = Math.round(part.nor[v * 3] * 1e4); nb = Math.round(part.nor[v * 3 + 1] * 1e4); nc = Math.round(part.nor[v * 3 + 2] * 1e4)
        }
        const key = `${a},${bb},${cc},${na},${nb},${nc}`
        let id = map.get(key)
        if (id === undefined) {
          id = qp.length / 3; map.set(key, id); qp.push(a, bb, cc)
          qn.push(opts.quantize ? na : part.nor[v * 3], opts.quantize ? nb : part.nor[v * 3 + 1], opts.quantize ? nc : part.nor[v * 3 + 2])
        }
        remap[v] = id
      }
      for (let k = 0; k < pidx.length; k += 3) {
        const i0 = remap[pidx[k]], i1 = remap[pidx[k + 1]], i2 = remap[pidx[k + 2]]
        if (i0 === i1 || i1 === i2 || i0 === i2) continue // degenerate after welding
        ix.push(i0, i1, i2)
      }
    }
    const nv = qp.length / 3
    if (!ix.length) continue
    // buffers
    let posView, posAcc, norView, norAcc
    if (opts.quantize) {
      const pa = new Int16Array(nv * 4), na = new Int8Array(nv * 4)
      const mnq = [Infinity, Infinity, Infinity], mxq = [-Infinity, -Infinity, -Infinity]
      for (let v = 0; v < nv; v++) {
        for (let k = 0; k < 3; k++) { const q = qp[v * 3 + k]; pa[v * 4 + k] = q; if (q < mnq[k]) mnq[k] = q; if (q > mxq[k]) mxq[k] = q; na[v * 4 + k] = qn[v * 3 + k] }
      }
      for (let k = 0; k < 3; k++) { qmnAll[k] = Math.min(qmnAll[k], mnq[k]); qmxAll[k] = Math.max(qmxAll[k], mxq[k]) }
      posView = addView(new Uint8Array(pa.buffer), 34962, 8)
      out.accessors.push({ bufferView: posView, componentType: 5122, normalized: true, count: nv, type: 'VEC3', min: mnq, max: mxq })
      posAcc = out.accessors.length - 1
      norView = addView(new Uint8Array(na.buffer), 34962, 4)
      out.accessors.push({ bufferView: norView, componentType: 5120, normalized: true, count: nv, type: 'VEC3' })
      norAcc = out.accessors.length - 1
    } else {
      const pa = new Float32Array(qp), na = new Float32Array(qn)
      const mnq = [Infinity, Infinity, Infinity], mxq = [-Infinity, -Infinity, -Infinity]
      for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) { const q = pa[v * 3 + k]; if (q < mnq[k]) mnq[k] = q; if (q > mxq[k]) mxq[k] = q }
      for (let k = 0; k < 3; k++) { qmnAll[k] = Math.min(qmnAll[k], mnq[k]); qmxAll[k] = Math.max(qmxAll[k], mxq[k]) }
      posView = addView(new Uint8Array(pa.buffer), 34962, 12)
      out.accessors.push({ bufferView: posView, componentType: 5126, count: nv, type: 'VEC3', min: mnq, max: mxq }); posAcc = out.accessors.length - 1
      norView = addView(new Uint8Array(na.buffer), 34962, 12)
      out.accessors.push({ bufferView: norView, componentType: 5126, count: nv, type: 'VEC3' }); norAcc = out.accessors.length - 1
    }
    const big = nv > 65535
    const ia = big ? new Uint32Array(ix) : new Uint16Array(ix)
    const iv = addView(new Uint8Array(ia.buffer), 34963)
    out.accessors.push({ bufferView: iv, componentType: big ? 5125 : 5123, count: ix.length, type: 'SCALAR' })
    prims.push({ attributes: { POSITION: posAcc, NORMAL: norAcc }, indices: out.accessors.length - 1, material: outMaterial(b.mat), mode: 4 })
    mv += nv; mt += ix.length / 3
  }
  if (!prims.length) continue
  out.meshes.push({ name: nm, primitives: prims })
  const node = { name: nm, mesh: out.meshes.length - 1 }
  if (opts.quantize) { node.translation = c; node.scale = [h, h, h] }
  out.nodes.push(node)
  totV += mv; totT += mt
  meshInfo.push({ name: nm, vertices: mv, triangles: mt, primitives: prims.length, _c: c, _h: h, _q: [qmnAll, qmxAll], _fl: !opts.quantize })
}
// root node first
const rootNode = { name: 'REBUILT_FIELD', children: out.nodes.map((_, i) => i + 1) }
const nodes = [rootNode, ...out.nodes]
for (const n of nodes.slice(1)) n.mesh = n.mesh // mesh indices unchanged (meshes array independent of nodes)
const gltf = {
  asset: { version: '2.0', generator: 'Crucible build-field.mjs', extras: { source: path.basename(inPath) } },
  scene: 0, scenes: [{ name: 'REBUILT 2026 field (WPILib frame, metres, Z up)', nodes: [0] }],
  nodes, meshes: out.meshes, materials: out.materials, accessors: out.accessors, bufferViews: out.bufferViews,
  buffers: [{ byteLength: binLen }]
}
if (opts.quantize) { gltf.extensionsUsed = ['KHR_mesh_quantization']; gltf.extensionsRequired = ['KHR_mesh_quantization'] }
function writeGlb(file, gltf, bins, len) {
  let js = Buffer.from(JSON.stringify(gltf), 'utf8')
  const jp = (4 - (js.length % 4)) % 4; if (jp) js = Buffer.concat([js, Buffer.alloc(jp, 0x20)])
  const binBuf = Buffer.concat(bins); const bp = (4 - (binBuf.length % 4)) % 4
  const bin = bp ? Buffer.concat([binBuf, Buffer.alloc(bp)]) : binBuf
  const total = 12 + 8 + js.length + 8 + bin.length
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8)
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4, 'latin1')
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'latin1')
  writeFileSync(file, Buffer.concat([head, jh, js, bh, bin])); return total
}
mkdirSync(outDir, { recursive: true })
const glbPath = path.join(outDir, 'rebuilt-field.glb')
const jsonPath = path.join(outDir, 'rebuilt-field.json')
const glbBytes = writeGlb(glbPath, gltf, out.bins, binLen)

// -------------------------------------------------------------------------------- reader (also used for verification)
function readOutput(file) {
  const r = readGlb(file)
  const G = r.json
  const res = { meshes: [], totalV: 0, totalT: 0, bytes: r.buf.length }
  for (const n of G.nodes) {
    if (n.mesh === undefined) continue
    const T = n.translation || [0, 0, 0], S = n.scale || [1, 1, 1]
    const m = G.meshes[n.mesh]
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    let v = 0, t = 0
    const prims = []
    for (const p of m.primitives) {
      const P = accessorReader(G, r.buf, r.binStart, p.attributes.POSITION)
      const I = accessorReader(G, r.buf, r.binStart, p.indices)
      const norm = G.accessors[p.attributes.POSITION].normalized
      const sc = norm ? (G.accessors[p.attributes.POSITION].componentType === 5122 ? 1 / 32767 : 1 / 127) : 1
      const arr = new Float64Array(P.count * 3)
      for (let i = 0; i < P.count; i++) for (let k = 0; k < 3; k++) {
        const x = T[k] + S[k] * P.get(i, k) * sc
        arr[i * 3 + k] = x
        if (x < bb[k]) bb[k] = x; if (x > bb[k + 3]) bb[k + 3] = x
      }
      let maxI = 0; for (let i = 0; i < I.count; i++) maxI = Math.max(maxI, I.get(i, 0))
      if (maxI >= P.count) throw new Error('index out of range in ' + n.name)
      v += P.count; t += I.count / 3
      prims.push({ pos: arr, idx: I, count: P.count })
    }
    res.meshes.push({ name: n.name, vertices: v, triangles: t, aabb: bb, prims })
    res.totalV += v; res.totalT += t
  }
  res.counts = { nodes: G.nodes.length, meshes: G.meshes.length, materials: (G.materials || []).length, accessors: G.accessors.length }
  return res
}
const rd = readOutput(glbPath)
const byName = new Map(rd.meshes.map((m) => [m.name, m]))
for (const mi of meshInfo) { const m = byName.get(mi.name); mi.aabb = m.aabb.map((x) => Math.round(x * 1e5) / 1e5); mi.aabb = { min: mi.aabb.slice(0, 3), max: mi.aabb.slice(3) }; delete mi._c; delete mi._h; delete mi._q; delete mi._fl }

// ---------------------------------------------------------------------------------------------- per-element reporting
const elementOf = (nm) => nm.replace(/_[0-9A-F]{6}(a\d+)?(_m\d+)?$/, '')
const groupAabb = new Map()
for (const m of rd.meshes) {
  const g0 = elementOf(m.name)
  const b = groupAabb.get(g0) || [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], m.aabb[k]); b[k + 3] = Math.max(b[k + 3], m.aabb[k + 3]) }
  groupAabb.set(g0, b)
}
const R = (x) => Math.round(x * 1e5) / 1e5
const box = (b) => ({ min: [R(b[0]), R(b[1]), R(b[2])], max: [R(b[3]), R(b[4]), R(b[5])] })
const srcToW = (b) => [FX - b[3], FY - b[4], b[2], FX - b[0], FY - b[1], b[5]] // source box -> WPILib box
// kept geometry per level-1 element: from the output buckets
const elemKept = new Map()
for (const b of buckets.values()) for (const part of b.parts) {
  // find which level-1 owns this part? we tracked tri counts per l1 only; rebuild AABB from the per-l1 info below
}
// To get exact kept AABB per level-1 element we recompute from the instances classification again (cheap: reuse bbox of kept instances)
const keptBox = new Map()
for (const inst of instances) {
  // recompute decision (same functions are pure)
  const e = L1.get(inst.l1)
  const cx = (inst.box[0] + inst.box[3]) / 2
  const centreX = (e.bbox[0] + e.bbox[3]) / 2
  const cls = classify(inst, /Perimeter/.test(e.name) ? cx : centreX)
  if (cls.fuel) continue
  if (cls.drop || (!cls.keep && inst.diag < opts.minDiag)) continue
  const kb = keptBox.get(inst.l1) || [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let k = 0; k < 6; k++) kb[k] = k < 3 ? Math.min(kb[k], inst.box[k]) : Math.max(kb[k], inst.box[k])
  keptBox.set(inst.l1, kb)
}
const elements = []
for (const [i, e] of L1) {
  if (/Fuel/.test(e.name)) continue
  elements.push({
    name: e.name, trianglesBefore: e.trisBefore, trianglesAfter: e.trisAfter,
    sourceAabbWpilib: box(srcToW(e.bbox)), // loose (accessor min/max of every part, dropped or not)
    keptAabbWpilib: keptBox.has(i) ? box(srcToW(keptBox.get(i))) : null
  })
}
const groups = {}
for (const [g0, b] of groupAabb) groups[g0] = box(b)

// ------------------------------------------------------------------------------------------------- AprilTags (from GLB)
const tagList = []
for (const m of rd.meshes) {
  const mm = /^APRILTAG_(\d+)$/.exec(m.name); if (!mm) continue
  // centre of the base poly = centre of the AABB of the whole tag mesh
  const b = m.aabb
  tagList.push({ id: Number(mm[1]), x: R((b[0] + b[3]) / 2), y: R((b[1] + b[4]) / 2), z: R((b[2] + b[5]) / 2), size: [R(b[3] - b[0]), R(b[4] - b[1]), R(b[5] - b[2])] })
}
tagList.sort((a, b) => a.id - b.id)

// --------------------------------------------------------------------------------------------------- HUB funnel profile
const hexNorm = (dx, dy) => Math.max(Math.abs(dy), 0.8660254037844386 * Math.abs(dx) + 0.5 * Math.abs(dy)) // flats on +-Y, vertices on X
function funnelProfile() {
  const res = { hubs: {}, orientation: null, rings: [], method: '' }
  const hubIds = Object.keys(funnel).map(Number).sort()
  let ringsFor = null
  for (const h of hubIds) {
    const verts = []
    for (const pos of funnel[h]) for (let v = 0; v < pos.length; v += 3) verts.push([pos[v], pos[v + 1], pos[v + 2]])
    let zmax = -Infinity, zmin = Infinity
    for (const p of verts) { zmax = Math.max(zmax, p[2]); zmin = Math.min(zmin, p[2]) }
    const top = verts.filter((p) => p[2] > zmax - 0.002)
    const cxw = (Math.min(...top.map((p) => p[0])) + Math.max(...top.map((p) => p[0]))) / 2
    const cyw = (Math.min(...top.map((p) => p[1])) + Math.max(...top.map((p) => p[1]))) / 2
    // source-frame alliance: red hub has x_w > field centre
    res.hubs[`Hub<${h}>`] = { centerX: R(cxw), centerY: R(cyw), alliance: cxw > FX ? 'red' : 'blue', rimZ: R(zmax), throatZ: R(zmin) }
    if (!ringsFor) ringsFor = { verts, cxw, cyw, zmax, zmin }
  }
  const { verts, cxw, cyw } = ringsFor
  // far vertex azimuth => orientation of the hexagon
  const topV = verts.filter((p) => p[2] > ringsFor.zmax - 0.002)
  const extX = Math.max(...topV.map((p) => Math.abs(p[0] - cxw))), extY = Math.max(...topV.map((p) => Math.abs(p[1] - cyw)))
  res.orientation = { halfExtentAlongX: R(extX), halfExtentAlongY: R(extY), verticesOnAxis: extX > extY ? 'X' : 'Y', flatsNormalAxis: extX > extY ? 'Y' : 'X',
    note: extX > extY ? 'hexagon vertices lie on the field X axis (one toward the alliance wall, one toward midfield); the two long flats are parallel to X with normals along +-Y' : 'hexagon vertices on Y, flats normal to X' }
  // cluster by z (0.5 mm); inner (opening) apothem = min hexnorm, outer = max
  const sorted = verts.slice().sort((a, b) => a[2] - b[2])
  const rings = []
  for (const p of sorted) {
    const last = rings[rings.length - 1]
    if (last && Math.abs(p[2] - last.zs[0]) < 0.0005) last.pts.push(p); else rings.push({ zs: [p[2]], pts: [p] })
  }
  for (const r of rings) {
    const hn = r.pts.map((p) => hexNorm(p[0] - cxw, p[1] - cyw))
    const inner = Math.min(...hn), outer = Math.max(...hn)
    r.z = r.pts.reduce((s, p) => s + p[2], 0) / r.pts.length
    r.inner = inner; r.outer = outer; r.n = r.pts.length
  }
  // The wall is a straight 60-degree hexagonal frustum with small 3 in steps; merge rings closer than 12 mm into one level.
  const good = rings.filter((r) => r.n > 8)
  const levels = []
  for (const r of good) { const l = levels[levels.length - 1]; if (l && r.z - l.zmax < 0.012) { l.rs.push(r); l.zmax = r.z } else levels.push({ rs: [r], zmax: r.z }) }
  res.levels = levels.map((l) => { const n = l.rs.reduce((s, r) => s + r.n, 0); const z = l.rs.reduce((s, r) => s + r.z * r.n, 0) / n; const a = l.rs.reduce((s, r) => s + r.inner * r.n, 0) / n; return { z: R(z), apothem: R(a), circumradius: R(a / 0.8660254037844386) } })
  { const xs = res.levels.map((l) => l.z), ys = res.levels.map((l) => l.apothem); const n = xs.length; const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n
    let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2 }
    const slope = num / den, b0 = my - slope * mx
    res.linearFit = { apothemOfZ: 'apothem = a0 + slope * (z - throatZ)', slope: R(slope), a0: R(b0 + slope * ringsFor.zmin), wallAngleFromHorizontalDeg: Math.round((Math.atan(1 / slope) * 1800) / Math.PI) / 10, apothemAtRimFit: R(b0 + slope * ringsFor.zmax), circumradiusOfApothem: 'apothem / cos(30 deg) = apothem * 1.1547' } }
  res.rimInner = { z: R(ringsFor.zmax), apothem: R(Math.min(...rings[rings.length - 1].pts.map((p) => hexNorm(p[0] - cxw, p[1] - cyw)))) }
  res.rimInner.circumradius = R(res.rimInner.apothem / 0.8660254037844386)
  res.rawRingCount = good.length
  const _unused = rings.filter((r) => r.n > 8).map((r) => ({ z: R(r.z), apothem: R(r.inner), circumradius: R(r.inner / 0.8660254037844386), outerApothem: R(r.outer), vertexCount: r.n }))
  res.method = 'All vertices of the six GE-26329 Hub Funnel Side parts of Hub<1> (baked, WPILib frame) are clustered by z (0.5 mm). Per ring: apothem = min over vertices of the hexagon norm max(|dy|, 0.866|dx|+0.5|dy|) about the funnel centre (the inner, ball-facing surface), circumradius = apothem/cos30, outerApothem = max of the same (the sheet is a few mm thick). The wall is a straight hexagonal frustum (about 60 degrees from horizontal) with small 3 in steps, so the raw 112 rings are merged into levels (12 mm) and a linear fit is given; use linearFit (or interpolate levels). rimInner is the opening seen from above (apothem 0.53 = the 41.7 in hexagon).'
  return res
}
// --------------------------------------------------------------------------------------------------- BUMP ridge profile
function bumpProfile() {
  if (!bumpTris.length) return null
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity
  for (const t of bumpTris) for (let v = 0; v < t.pos.length; v += 3) { mnx = Math.min(mnx, t.pos[v]); mxx = Math.max(mxx, t.pos[v]); mny = Math.min(mny, t.pos[v + 1]); mxy = Math.max(mxy, t.pos[v + 1]) }
  const cx = (mnx + mxx) / 2
  let maxVz = -Infinity; for (const t of bumpTris) for (let v = 2; v < t.pos.length; v += 3) maxVz = Math.max(maxVz, t.pos[v])
  const step = 0.005
  const nb = Math.round((mxx - mnx) / step) + 1
  const env = new Float64Array(nb).fill(-Infinity)
  for (const t of bumpTris) {
    for (let k = 0; k < t.idx.length; k += 3) {
      const A = [t.idx[k], t.idx[k + 1], t.idx[k + 2]].map((i) => [t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]])
      // face normal z (upward facing only)
      const ux = A[1][0] - A[0][0], uy = A[1][1] - A[0][1], vx = A[2][0] - A[0][0], vy = A[2][1] - A[0][1]
      const nz = ux * vy - uy * vx
      if (nz <= 0) continue
      const xmin = Math.min(A[0][0], A[1][0], A[2][0]), xmax = Math.max(A[0][0], A[1][0], A[2][0])
      for (let b = Math.max(0, Math.ceil((xmin - mnx) / step)); b <= Math.min(nb - 1, Math.floor((xmax - mnx) / step)); b++) {
        const x = mnx + b * step
        for (let e = 0; e < 3; e++) {
          const p = A[e], q = A[(e + 1) % 3]
          if ((x - p[0]) * (x - q[0]) > 0) continue
          const dxe = q[0] - p[0]
          const z = Math.abs(dxe) < 1e-12 ? Math.max(p[2], q[2]) : p[2] + ((x - p[0]) / dxe) * (q[2] - p[2])
          if (z > env[b]) env[b] = z
        }
      }
    }
  }
  const pts = []
  for (let b = 0; b < nb; b++) if (env[b] > -Infinity) pts.push([R(mnx + b * step - cx), R(env[b])])
  // Douglas-Peucker, 0.5 mm
  const dp = (a, lo, hi, tol, keep) => {
    let md = 0, mi = -1
    for (let i = lo + 1; i < hi; i++) {
      const t = (a[i][0] - a[lo][0]) / (a[hi][0] - a[lo][0]); const zi = a[lo][1] + t * (a[hi][1] - a[lo][1]); const d = Math.abs(a[i][1] - zi)
      if (d > md) { md = d; mi = i }
    }
    if (md > tol) { keep.add(mi); dp(a, lo, mi, tol, keep); dp(a, mi, hi, tol, keep) }
  }
  const keep = new Set([0, pts.length - 1]); dp(pts, 0, pts.length - 1, 0.0015, keep)
  let simp = [...keep].sort((a, b) => a - b).map((i) => pts[i])
  // the crest is a ~1 cm wide groove/peak: collapse everything within 2 cm of the centre line to one apex point at the true max z
  simp = simp.filter((p) => Math.abs(p[0]) >= 0.02); simp.splice(simp.findIndex((p) => p[0] > 0), 0, [0, R(maxVz)])
  // slope of the ramps: fit between 20% and 80% of the half width
  const half = pts.filter((p) => p[0] > 0.1 && p[0] < 0.45)
  let slopeDeg = null
  if (half.length > 2) { const a = half[0], b = half[half.length - 1]; slopeDeg = Math.round((Math.atan2(a[1] - b[1], b[0] - a[0]) * 1800) / Math.PI) / 10 }
  return {
    centerX: R(cx), yRange: [R(mny), R(mxy)], widthX: R(mxx - mnx), widthY: R(mxy - mny), peakZ: R(Math.max(...pts.map((p) => p[1]))),
    maxZ: R(maxVz), ridge: simp, rampSlopeDeg: slopeDeg,
    method: 'Upper envelope (max z over the full 73 in bump width) of the upward-facing triangles of the six BUMP PLASTIC parts of one bump (GE-26101), sampled every 5 mm in x and simplified with Douglas-Peucker (1.5 mm). x is the offset from the bump centre (= the hub centre x); the shape is symmetric about 0 and constant in y.'
  }
}
const funnelOut = funnelProfile()
const bumpOut = bumpProfile()

// -------------------------------------------------------------------------------------------------------------- JSON
const fuelOut = fuel.map((f) => ({ x: R(f.x), y: R(f.y), z: R(f.z), group: f.group })).sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.x - b.x || a.y - b.y))
const fuelCounts = {}; for (const f of fuelOut) fuelCounts[f.group] = (fuelCounts[f.group] || 0) + 1
let srcTotT = 0; for (const e of L1.values()) srcTotT += e.trisBefore
const report = {
  source: { file: path.basename(inPath), bytes: buf.length, nodes: N.length, meshes: g.meshes.length, instancedTrianglesNonFuel: srcTotT, fuelBalls: fuel.length },
  buildParameters: { minDiagMeters: opts.minDiag, quantized: opts.quantize, dropInternal: opts.dropInternal, dropWheels: opts.dropWheels, dropRules: { DROP_OWN: DROP_OWN.map(String), DROP_WHEELS: DROP_WHEELS.map(String), DROP_ANC: DROP_ANC.map(String), DROP_INTERNAL: DROP_INTERNAL.map(String), KEEP: KEEP.map(String) }, keptAlwaysExemptFromSizeRule: ['AprilTags', 'tape', 'KEEP list'], dedupe: 'identical baked geometry (material, counts, bbox 0.1 mm, vertex sum)' },
  transform: { description: 'WPILib frame: x_w = 8.2705 - x_glb, y_w = 4.0345 - y_glb, z_w = z_glb (180 deg rotation about Z + translation, proper, winding kept). Metres, Z up, origin at the blue-wall corner.', matrix4x4ColumnMajor: FRAME, alliances: 'source x<0 is RED => WPILib x > 8.27 is RED (IDs 1-16), x < 8.27 is BLUE (IDs 17-32)', inputFieldInner: { length: 2 * FX, width: 2 * FY }, rootNode: 'identity', quantization: opts.quantize ? 'KHR_mesh_quantization: int16 normalized POSITION (node translation + uniform scale), int8 normalized NORMAL' : 'float32' },
  output: { file: 'rebuilt-field.glb', bytes: glbBytes, vertices: rd.totalV, triangles: rd.totalT, meshes: rd.counts.meshes, nodes: rd.counts.nodes, materials: rd.counts.materials, accessors: rd.counts.accessors, buildSeconds: 0 },
  simplify: simpInfo,
  droppedNamesTop: Object.fromEntries(Object.entries(stat.dropNames).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n, c]) => `${c}x ${n}`)])),
  droppedByRule: { ...stat.dropped, size: { n: stat.dropped.size ? stat.dropped.size.n : 0, tris: stat.dropped.size ? stat.dropped.size.tris : 0, topNames: Object.entries(stat.droppedSize.byNames).sort((a, b) => b[1] - a[1]).slice(0, 25) }, duplicatesSkipped: stat.dedupe },
  elements, groups, meshes: meshInfo,
  aprilTags: tagList,
  fuel: { total: fuelOut.length, counts: fuelCounts, diameter: 0.15, positions: fuelOut },
  hubFunnel: funnelOut, bumpRidge: bumpOut
}
report.output.buildSeconds = Math.round((Date.now() - T0)) / 1000
writeFileSync(jsonPath, JSON.stringify(report, null, 1))

// -------------------------------------------------------------------------------------------------------- verification
if (opts.verify) {
  const v = readOutput(glbPath)
  const tol = 0.001
  const fails = []
  const chk = (label, got, want, t = tol) => { const ok = Math.abs(got - want) <= t; log(`  ${ok ? 'ok  ' : 'DIFF'} ${label}: got ${got.toFixed(4)} want ${want.toFixed(4)}`); if (!ok) fails.push(label) }
  log('verify: re-parsed output GLB')
  log(`  meshes ${v.meshes.length}, vertices ${v.totalV}, triangles ${v.totalT}, bytes ${v.bytes} (reported ${rd.totalT} tris)`)
  const grp = (re) => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (const m of v.meshes) if (re.test(m.name)) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], m.aabb[k]); b[k + 3] = Math.max(b[k + 3], m.aabb[k + 3]) } return b }
  // survey numbers in the SOURCE frame converted with the frame change
  const sx = (x) => FX - x, sy = (y) => FY - y
  const hubR = grp(/^HUB_red/), hubB = grp(/^HUB_blue/)
  chk('HUB red x min (src x 2.7737 -> 5.4968?)', hubR[0], sx(-2.7737)); chk('HUB red x max', hubR[3], sx(-4.2577)); chk('HUB red y min', hubR[1], sy(0.7422)); chk('HUB red y max', hubR[4], sy(-0.7422)); chk('HUB red z max (net pole top)', hubR[5], 3.0572)
  chk('HUB blue x min', hubB[0], sx(4.2577)); chk('HUB blue x max', hubB[3], sx(2.7737))
  const hubCenterOffset = Math.abs(sx(-3.6449) - FX)
  chk('HUB centre distance from field centre', hubCenterOffset, 3.6449)
  const bumpAll = grp(/^BUMP_/)
  const bumpRed = (() => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (const m of v.meshes) if (/^BUMP_red/.test(m.name)) for (const p of m.prims) { for (let i = 0; i < p.count; i++) { if (p.pos[i * 3 + 1] > FY) continue; for (let k = 0; k < 3; k++) { const x = p.pos[i * 3 + k]; if (x < b[k]) b[k] = x; if (x > b[k + 3]) b[k + 3] = x } } } return b })()
  chk('BUMP size x (one bump, 1.1276)', bumpRed[3] - bumpRed[0], 1.1276); chk('BUMP size y (1.8562)', bumpRed[4] - bumpRed[1], 1.8562); chk('BUMP height z (0.1654)', bumpRed[5], 0.1654)
  const tw = grp(/^TOWER_red/); chk('TOWER red x extent (1.1938-ish, screw heads dropped)', tw[3] - tw[0], 1.1938, 0.0035); chk('TOWER red y extent 1.2509', tw[4] - tw[1], 1.2509); chk('TOWER red z max (src 1.9909 incl screw heads)', tw[5], 1.9909, 0.008)
  const tr = grp(/^TRENCH_red/); chk('TRENCH red x extent 1.1938', tr[3] - tr[0], 1.1938); chk('TRENCH red y extent 8.3717', tr[4] - tr[1], 8.3717); chk('TRENCH red z max 1.0223', tr[5], 1.0223)
  const dp = grp(/^DEPOT_red/); chk('DEPOT red x min', dp[0], sx(-7.5847)); chk('DEPOT red x max', dp[3], sx(-8.2705)); chk('DEPOT red y min', dp[1], sy(2.4638)); chk('DEPOT red y max', dp[4], sy(1.397))
  const gr = grp(/^GUARDRAIL/); log(`  GUARDRAIL y range ${gr[1].toFixed(4)}..${gr[4].toFixed(4)} (inner faces at ${(FY - 4.0345).toFixed(4)} / ${(FY + 4.0345).toFixed(4)}); x range ${gr[0].toFixed(4)}..${gr[3].toFixed(4)}`)
  // rim: any vertex of the HUB meshes within 1 mm of z=1.8288 near the hexagon (hexnorm 0.5298..0.5325 about the hub centre)
  let rimHits = 0, rimMax = -Infinity
  const hc = funnelOut.hubs[Object.keys(funnelOut.hubs)[0]]
  for (const m of v.meshes) if (/^HUB_/.test(m.name)) for (const p of m.prims) for (let i = 0; i < p.count; i++) {
    const z = p.pos[i * 3 + 2]; if (Math.abs(z - 1.8288) < 0.001) { const hn = hexNorm(p.pos[i * 3] - hc.centerX, p.pos[i * 3 + 1] - hc.centerY); if (hn > 0.52 && hn < 0.54) rimHits++ }
  }
  log(`  HUB funnel rim vertices at z 1.8288 on the hexagon (red hub 1): ${rimHits}  ${rimHits > 6 ? 'ok' : 'MISSING'}`)
  if (rimHits <= 6) fails.push('rim')
  chk('field inner length (guardrail/wall frame)', 2 * FX, 16.541, 1e-9); chk('field inner width', 2 * FY, 8.069, 1e-9)
  const tagsOk = v.meshes.filter((m) => /^APRILTAG_/.test(m.name)).length
  log(`  AprilTag meshes ${tagsOk} (expected 32) ${tagsOk === 32 ? 'ok' : 'MISSING'}`); if (tagsOk !== 32) fails.push('tags')
  log(fails.length ? `verify: ${fails.length} difference(s): ${fails.join('; ')}` : 'verify: all checks within tolerance')
}

// -------------------------------------------------------------------------------------------------------------- summary
log(`\noutput ${glbPath}  ${(glbBytes / 1048576).toFixed(2)} MB, ${rd.totalV} vertices, ${rd.totalT} triangles, ${rd.counts.meshes} meshes, ${rd.counts.materials} materials`)
log('per element (triangles before -> after):')
for (const e of elements) log(`  ${String(e.trianglesBefore).padStart(9)} -> ${String(e.trianglesAfter).padStart(7)}  ${e.name}`)
log('dropped by rule:', JSON.stringify(Object.fromEntries(Object.entries(stat.dropped).map(([k, x]) => [k, `${x.n} inst / ${x.tris} tris`]))))
if (process.env.FIELD_RANK) {
  const agg = {}
  for (const b of buckets.values()) for (const p of b.parts) { const a = agg[p.nm] || (agg[p.nm] = [0, 0, 0]); a[0]++; a[1] += p.idx.length / 3; a[2] += (p.idxS || p.idx).length / 3 }
  for (const [k, a] of Object.entries(agg).sort((x, y) => y[1][2] - x[1][2]).slice(0, 60)) log(String(a[1]).padStart(8), '->', String(a[2]).padStart(8), String(a[0]).padStart(4) + 'x', k)
}
log(`peak memory ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`)
log(`json ${jsonPath}  (${(statSync(jsonPath).size / 1024).toFixed(0)} KB); build ${(Date.now() - T0) / 1000} s`)
