'use strict';
// Minimal NetworkTables 4 client for the M0 spikes. No dependencies: Node's built-in WebSocket and a tiny MessagePack.
// Only what the spikes need: publish/subscribe `raw` topics and exchange binary value frames.

const PROTOCOL = 'v4.1.networktables.first.wpi.edu';
const TYPE_RAW = 5; // NT4 data type index for raw (bin)

function uint(n) {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0xcc, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = 0xcd; b.writeUInt16BE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xcf; b.writeBigUInt64BE(BigInt(n), 1); return b;
}
function bin(buf) {
  const n = buf.length;
  if (n < 256) return Buffer.concat([Buffer.from([0xc4, n]), buf]);
  if (n < 65536) { const h = Buffer.alloc(3); h[0] = 0xc5; h.writeUInt16BE(n, 1); return Buffer.concat([h, buf]); }
  const h = Buffer.alloc(5); h[0] = 0xc6; h.writeUInt32BE(n, 1); return Buffer.concat([h, buf]);
}
// [id, timestampMicros, typeIndex, value]; timestamp 0 lets the server stamp it
function encodeRawFrame(id, bytes) {
  return Buffer.concat([Buffer.from([0x94]), uint(id), uint(0), uint(TYPE_RAW), bin(bytes)]);
}

function decode(b, o) {
  const t = b[o];
  if (t <= 0x7f) return [t, o + 1];
  if (t >= 0xe0) return [t - 256, o + 1];
  if (t >= 0x90 && t <= 0x9f) {
    const n = t & 0x0f; let off = o + 1; const arr = [];
    for (let i = 0; i < n; i++) { const [v, nx] = decode(b, off); arr.push(v); off = nx; }
    return [arr, off];
  }
  switch (t) {
    case 0xc0: return [null, o + 1];
    case 0xc2: return [false, o + 1];
    case 0xc3: return [true, o + 1];
    case 0xc4: { const n = b[o + 1]; return [b.subarray(o + 2, o + 2 + n), o + 2 + n]; }
    case 0xc5: { const n = b.readUInt16BE(o + 1); return [b.subarray(o + 3, o + 3 + n), o + 3 + n]; }
    case 0xc6: { const n = b.readUInt32BE(o + 1); return [b.subarray(o + 5, o + 5 + n), o + 5 + n]; }
    case 0xca: return [b.readFloatBE(o + 1), o + 5];
    case 0xcb: return [b.readDoubleBE(o + 1), o + 9];
    case 0xcc: return [b[o + 1], o + 2];
    case 0xcd: return [b.readUInt16BE(o + 1), o + 3];
    case 0xce: return [b.readUInt32BE(o + 1), o + 5];
    case 0xcf: return [Number(b.readBigUInt64BE(o + 1)), o + 9];
    case 0xd0: return [b.readInt8(o + 1), o + 2];
    case 0xd1: return [b.readInt16BE(o + 1), o + 3];
    case 0xd2: return [b.readInt32BE(o + 1), o + 5];
    case 0xd3: return [Number(b.readBigInt64BE(o + 1)), o + 9];
    case 0xd9: { const n = b[o + 1]; return [b.toString('utf8', o + 2, o + 2 + n), o + 2 + n]; }
    case 0xa0: return ['', o + 1];
    default:
      if (t >= 0xa0 && t <= 0xbf) { const n = t & 0x1f; return [b.toString('utf8', o + 1, o + 1 + n), o + 1 + n]; }
      throw new Error('unsupported msgpack type 0x' + t.toString(16));
  }
}

class NT4Client {
  constructor({ host = '127.0.0.1', port = 5810, name = 'crucible-spike' } = {}) {
    this.url = `ws://${host}:${port}/nt/${name}`;
    this.uid = 1;
    this.topicIds = new Map();      // topic name -> server id
    this.handlers = new Map();      // topic name -> callback(Buffer)
    this.idToName = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, PROTOCOL);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error('websocket error: ' + (e.message || e.type)));
      ws.onmessage = (ev) => this._onMessage(ev.data);
    });
  }
  _sendJson(method, params) { this.ws.send(JSON.stringify([{ method, params }])); }
  publish(name, type = 'raw') {
    const pubuid = this.uid++;
    this._sendJson('publish', { name, type, pubuid, properties: {} });
    return pubuid;
  }
  subscribe(name, onValue, options = { all: true, periodic: 0.001 }) {
    this.handlers.set(name, onValue);
    this._sendJson('subscribe', { topics: [name], subuid: this.uid++, options });
  }
  sendRaw(pubuid, bytes) { this.ws.send(encodeRawFrame(pubuid, bytes)); }
  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }

  _onMessage(data) {
    if (typeof data === 'string') {
      for (const m of JSON.parse(data)) {
        if (m.method === 'announce') {
          this.topicIds.set(m.params.name, m.params.id);
          this.idToName.set(m.params.id, m.params.name);
        }
      }
      return;
    }
    const buf = Buffer.from(data);
    let off = 0;
    while (off < buf.length) {
      const [msg, nx] = decode(buf, off);
      off = nx;
      const [id, , , value] = msg;
      if (id < 0) continue; // time sync
      const name = this.idToName.get(id);
      const h = name && this.handlers.get(name);
      if (h && Buffer.isBuffer(value)) h(value);
    }
  }
}

module.exports = { NT4Client };
