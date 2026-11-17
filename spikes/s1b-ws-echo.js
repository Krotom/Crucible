'use strict';
// Control for spike S1: a plain WebSocket echo server (no NetworkTables) to see what the machine itself can do.
// Minimal RFC 6455 server: upgrade handshake, masked client frames in, unmasked binary frames out.
const http = require('http');
const crypto = require('crypto');

const port = Number(process.argv[2] || 5820);
const server = http.createServer();

function frame(payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x82, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x82; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (opcode === 8) { socket.end(); return; }
      if (opcode === 1 || opcode === 2) socket.write(frame(payload)); // echo
    }
  });
  socket.on('error', () => {});
});
server.listen(port, '127.0.0.1', () => console.log('READY ws-echo ' + port));
process.on('SIGTERM', () => process.exit(0));
