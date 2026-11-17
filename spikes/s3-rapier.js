'use strict';
// Spike S3: Rapier performance with many balls, and determinism (same process, across processes, snapshot/restore).
//   node s3-rapier.js det     deterministic build (@dimforge/rapier3d-deterministic-compat)
//   node s3-rapier.js plain   standard build (@dimforge/rapier3d-compat), for a speed comparison
const crypto = require('crypto');
const kind = process.argv[2] || 'det';
const RAPIER = require(kind === 'plain' ? '@dimforge/rapier3d-compat' : '@dimforge/rapier3d-deterministic-compat');

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const R = 0.075;            // ball radius, m (the CAD fuel is 150 mm across)
const MASS = 0.2;           // kg, placeholder until the rules say
const DENSITY = MASS / ((4 / 3) * Math.PI * R ** 3);
const DT = 0.001;

function build(nBalls, seed) {
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  world.timestep = DT;
  const solid = (c) => world.createCollider(c.setFriction(0.8).setRestitution(0.4));
  solid(RAPIER.ColliderDesc.cuboid(8.25, 4.1, 0.1).setTranslation(8.25, 4.1, -0.1));          // floor
  solid(RAPIER.ColliderDesc.cuboid(8.25, 0.1, 1.0).setTranslation(8.25, -0.1, 1.0));          // walls
  solid(RAPIER.ColliderDesc.cuboid(8.25, 0.1, 1.0).setTranslation(8.25, 8.3, 1.0));
  solid(RAPIER.ColliderDesc.cuboid(0.1, 4.1, 1.0).setTranslation(-0.1, 4.1, 1.0));
  solid(RAPIER.ColliderDesc.cuboid(0.1, 4.1, 1.0).setTranslation(16.6, 4.1, 1.0));
  const rand = rng(seed);
  const balls = [];
  for (let i = 0; i < nBalls; i++) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(1 + rand() * 14, 0.5 + rand() * 7, 0.2 + rand() * 2)
      .setCcdEnabled(true));
    world.createCollider(RAPIER.ColliderDesc.ball(R).setDensity(DENSITY).setRestitution(0.6).setFriction(0.6), body);
    balls.push(body);
  }
  const robot = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(2, 4, 0.12));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.43, 0.43, 0.12), robot);
  return { world, balls, robot };
}

function stepSim(sim, steps, t0 = 0) {
  for (let i = 0; i < steps; i++) {
    const t = t0 + i * DT;
    sim.robot.setLinvel({ x: 2.0 * Math.cos(0.6 * t), y: 1.5 * Math.sin(0.9 * t), z: 0 }, true); // plows around the field
    sim.world.step();
  }
}

function hashWorld(world) {
  const h = crypto.createHash('sha256');
  const f = new Float64Array(6);
  world.bodies.forEach((b) => {
    const p = b.translation(), v = b.linvel();
    f[0] = p.x; f[1] = p.y; f[2] = p.z; f[3] = v.x; f[4] = v.y; f[5] = v.z;
    h.update(Buffer.from(f.buffer));
  });
  return h.digest('hex').slice(0, 16);
}

(async () => {
  await RAPIER.init();
  console.log(`S3 build: ${kind} (rapier ${RAPIER.version ? RAPIER.version() : 'n/a'})`);

  // ---- performance: 5 s of simulated time at 1 ms steps
  for (const n of (process.argv[3] === "hashonly" ? [] : [100, 300, 600, 1000])) {
    const sim = build(n, 1);
    const t0 = process.hrtime.bigint();
    stepSim(sim, 5000);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let asleep = 0; sim.balls.forEach((b) => { if (b.isSleeping()) asleep++; });
    console.log(`S3 perf ${String(n).padStart(4)} balls: 5.0 s sim in ${ms.toFixed(0)} ms wall = ${(5000 / ms).toFixed(1)}x real time, ${(ms / 5000).toFixed(3)} ms/step; asleep at end: ${asleep}`);
  }

  // ---- determinism in one process: same seed twice
  const a = build(300, 7); stepSim(a, 3000);
  const b = build(300, 7); stepSim(b, 3000);
  console.log(`S3 determinism, same process, 300 balls 3 s: ${hashWorld(a.world)} vs ${hashWorld(b.world)} -> ${hashWorld(a.world) === hashWorld(b.world) ? 'IDENTICAL' : 'DIFFERENT'}`);

  // ---- snapshot/restore: run 1.5 s, snapshot, run 1.5 s more (A); restore the snapshot and run 1.5 s again (B)
  const c = build(300, 11); stepSim(c, 1500);
  const snap = c.world.takeSnapshot();
  stepSim(c, 1500, 1.5);
  const hashA = hashWorld(c.world);
  const restored = RAPIER.World.restoreSnapshot(snap);
  const robotB = restored.getRigidBody(c.robot.handle);
  const sim2 = { world: restored, robot: robotB };
  stepSim(sim2, 1500, 1.5);
  const hashB = hashWorld(restored);
  console.log(`S3 snapshot/restore (snapshot ${snap.length} bytes): continued ${hashA} vs restored ${hashB} -> ${hashA === hashB ? 'IDENTICAL' : 'DIFFERENT'}`);

  // ---- cross-process: print a hash another process can compare
  const d = build(300, 99); stepSim(d, 3000);
  console.log(`S3 CROSS-PROCESS HASH (300 balls, seed 99, 3 s): ${hashWorld(d.world)}`);
})();
