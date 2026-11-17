'use strict';
// Spike S3b: steady-state cost. Balls settle first (no robot motion), then a kinematic robot plows through them.
// Compares CCD on/off and 1 ms vs 2 ms vs 4 ms steps.   node s3b-steady.js det|plain
const kind = process.argv[2] || 'det';
const RAPIER = require(kind === 'plain' ? '@dimforge/rapier3d-compat' : '@dimforge/rapier3d-deterministic-compat');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = 0.075, MASS = 0.2, DENSITY = MASS / ((4 / 3) * Math.PI * R ** 3);

function build(n, ccd, dt) {
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  world.timestep = dt;
  if (process.env.ITER) world.integrationParameters.numSolverIterations = Number(process.env.ITER);
  const solid = (c) => world.createCollider(c.setFriction(0.8).setRestitution(0.4));
  solid(RAPIER.ColliderDesc.cuboid(8.25, 4.1, 0.1).setTranslation(8.25, 4.1, -0.1));
  solid(RAPIER.ColliderDesc.cuboid(8.25, 0.1, 1.0).setTranslation(8.25, -0.1, 1.0));
  solid(RAPIER.ColliderDesc.cuboid(8.25, 0.1, 1.0).setTranslation(8.25, 8.3, 1.0));
  solid(RAPIER.ColliderDesc.cuboid(0.1, 4.1, 1.0).setTranslation(-0.1, 4.1, 1.0));
  solid(RAPIER.ColliderDesc.cuboid(0.1, 4.1, 1.0).setTranslation(16.6, 4.1, 1.0));
  const rand = rng(3);
  const balls = [];
  // balls start on a non-overlapping grid (spacing 0.17 m) in a 8 x 6 m region, resting height; damping stands in for rolling resistance
  const cols = Math.floor(8 / 0.17);
  for (let i = 0; i < n; i++) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(6.5 + (i % cols) * 0.17, 1.2 + Math.floor(i / cols) * 0.17, R + 0.02)
      .setLinearDamping(0.05).setAngularDamping(2.0).setCcdEnabled(ccd));
    world.createCollider(RAPIER.ColliderDesc.ball(R).setDensity(DENSITY).setRestitution(0.5).setFriction(0.6), body);
    balls.push(body);
  }
  const robot = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(5.2, 1.7, 0.12));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.43, 0.43, 0.12), robot);
  return { world, balls, robot, dt };
}

function run(sim, seconds, moveRobot) {
  const steps = Math.round(seconds / sim.dt);
  for (let i = 0; i < steps; i++) {
    // drives from x=3 toward the pile and back, at up to 2 m/s
        // plows straight through the pile along y = 1.7 m at 1.5 m/s
    const vx = moveRobot ? 1.5 : 0, vy = 0;
    sim.robot.setLinvel({ x: vx, y: vy, z: 0 }, true);
    sim.world.step();
  }
}

(async () => {
  await RAPIER.init();
  console.log(`S3b build: ${kind}`);
  for (const cfg of (process.env.ITER ? [{ ccd: false, dt: 0.002 }] : [{ ccd: false, dt: 0.001 }, { ccd: false, dt: 0.002 }, { ccd: false, dt: 0.004 }])) {
    for (const n of (process.env.ITER ? [300, 600] : [300, 600, 1000])) {
      const sim = build(n, cfg.ccd, cfg.dt);
      run(sim, 6, false); // settle
      let asleepSettled = 0; sim.balls.forEach((b) => { if (b.isSleeping()) asleepSettled++; });
      const t0 = process.hrtime.bigint();
      run(sim, 4, true);  // robot plows through the pile
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      let asleep = 0; sim.balls.forEach((b) => { if (b.isSleeping()) asleep++; });
      console.log(`S3b ccd=${cfg.ccd ? 'on ' : 'off'} step=${(cfg.dt * 1000).toFixed(0)} ms ${String(n).padStart(4)} balls: 4 s with robot in ${String(ms.toFixed(0)).padStart(5)} ms = ${(4000 / ms).toFixed(1).padStart(5)}x real time (${(ms / (4 / cfg.dt)).toFixed(3)} ms/step); asleep after settle ${asleepSettled}, after robot ${asleep}`);
    }
  }
})();
