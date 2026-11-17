'use strict';
// The "app" side of spikes S1 and S2: answers ToApp frames with FromApp frames (see docs/NT_CONTRACT.md).
//   --mode echo   S1: reply immediately with zeros (round-trip latency / throughput)
//   --mode hood   S2: integrate a DC motor + gearbox + inertia from the applied voltage and return rotor state
const { NT4Client } = require('./nt4');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const port = Number(arg('port', '5810'));
const mode = arg('mode', 'echo');
const robot = arg('robot', 'main');

// motor + mechanism (S2), passed in by the Java harness so there is one source of truth
const R = Number(arg('r', '0.0436'));          // ohms
const Kt = Number(arg('kt', '0.0147'));        // N*m / A
const Kv = Number(arg('kv', '65'));            // rad/s / V
const ratio = Number(arg('ratio', '16.40625'));
const inertia = Number(arg('inertia', '0.02')); // kg m^2 at the mechanism output

const HDR_TO = 36, MOTOR_TO = 16;
const MAGIC_FROM = 0x32464253;

// state of the one simulated mechanism (output side, radians)
let pos = 0, vel = 0;
// x' = a x + b V  (WPILib LinearSystemId.createDCMotorSystem)
const a = -(ratio * ratio) * Kt / (Kv * R * inertia);
const b = (ratio * Kt) / (R * inertia);

function step(volts, dt) {
  // exact solution of the 1-D linear system for constant input over dt
  const e = Math.exp(a * dt);
  const vss = -b * volts / a;
  const newVel = vss + (vel - vss) * e;
  pos += vss * dt + (vel - vss) * (e - 1) / a;
  vel = newVel;
}

let lastSimTime = null;
function onToApp(buf) {
  const seq = buf.readBigUInt64LE(8);
  const simTime = buf.readDoubleLE(16);
  const nMotors = buf.readUInt16LE(32);
  let volts = 0, id = 0, flags = 0;
  if (nMotors > 0) { id = buf.readInt32LE(HDR_TO); volts = buf.readDoubleLE(HDR_TO + 4); flags = buf.readUInt32LE(HDR_TO + 12); }

  if (mode === 'hood') {
    const dt = lastSimTime === null ? 0.005 : Math.min(Math.max(simTime - lastSimTime, 0), 0.05);
    lastSimTime = simTime;
    const sub = Math.max(1, Math.round(dt / 0.001));
    const v = (flags & 2) ? 0 : volts; // neutral output
    for (let i = 0; i < sub; i++) step(v, dt / sub);
  }

  // FromApp frame: header 40 bytes + one motor (i32 id + 3 x f64 = 28 bytes)
  const out = Buffer.alloc(40 + 28);
  out.writeUInt32LE(MAGIC_FROM, 0);
  out.writeUInt32LE(0, 4);
  out.writeBigUInt64LE(seq, 8);
  out.writeDoubleLE(simTime, 16);
  out.writeDoubleLE(12.0, 24);
  out.writeUInt16LE(1, 32); // nMotors
  out.writeInt32LE(id, 40);
  const rotorPos = (pos / (2 * Math.PI)) * ratio;  // rotations, rotor side
  const rotorVel = (vel / (2 * Math.PI)) * ratio;  // rps, rotor side
  out.writeDoubleLE(mode === 'hood' ? rotorPos : 0, 44);
  out.writeDoubleLE(mode === 'hood' ? rotorVel : 0, 52);
  out.writeDoubleLE(0, 60);
  nt.sendRaw(pubuid, out);
}

const nt = new NT4Client({ port, name: 'crucible-spike' });
let pubuid;
(async () => {
  await nt.connect();
  pubuid = nt.publish(`/SimBridge/${robot}/FromApp/Frame`);
  nt.subscribe(`/SimBridge/${robot}/ToApp/Frame`, onToApp);
  console.log('READY mode=' + mode);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });

process.on('SIGTERM', () => { nt.close(); process.exit(0); });
