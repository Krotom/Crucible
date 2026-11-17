package frc.robot.lib.simbridge;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

/**
 * A minimal RFC 6455 WebSocket server for the sim bridge: one client at a time (a newer one replaces the older), binary
 * messages, localhost only. NetworkTables batches updates in tens of milliseconds, which is far too slow for the Talons'
 * control loops to run against an external physics app; this channel measures well under a millisecond locally.
 */
final class WsServer {
    interface Listener {
        void onConnect();

        void onMessage(byte[] message);

        void onDisconnect();
    }

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final int port;
    private final Listener listener;
    private ServerSocket server;
    private volatile Socket client;
    private volatile OutputStream out;
    private final Object writeLock = new Object();

    WsServer(int port, Listener listener) {
        this.port = port;
        this.listener = listener;
    }

    void start() throws IOException {
        server = new ServerSocket(port, 4, InetAddress.getLoopbackAddress());
        Thread t = new Thread(this::acceptLoop, "CrucibleBridgeWs");
        t.setDaemon(true);
        t.start();
    }

    boolean connected() { return out != null; }

    /** Sends one binary message; silently dropped when nobody is connected. */
    void send(byte[] payload) {
        OutputStream o = out;
        if (o == null) return;
        synchronized (writeLock) {
            try {
                int n = payload.length;
                ByteArrayOutputStream head = new ByteArrayOutputStream(10);
                head.write(0x82);
                if (n < 126) head.write(n);
                else if (n < 65536) { head.write(126); head.write(n >> 8); head.write(n & 0xff); }
                else { head.write(127); for (int i = 7; i >= 0; i--) head.write((int) (((long) n >> (8 * i)) & 0xff)); }
                o.write(head.toByteArray());
                o.write(payload);
                o.flush();
            } catch (IOException e) {
                close(client);
            }
        }
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try {
                Socket s = server.accept();
                Thread t = new Thread(() -> serve(s), "CrucibleBridgeWsClient");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket s) {
        try {
            s.setTcpNoDelay(true);
            InputStream in = s.getInputStream();
            String key = handshake(in);
            if (key == null) { s.close(); return; }
            OutputStream o = s.getOutputStream();
            o.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                    + accept(key) + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            o.flush();
            Socket old = client;
            client = s;
            out = o;
            if (old != null) close(old);
            listener.onConnect();
            readLoop(in, o);
        } catch (IOException e) {
            // connection lost
        } finally {
            boolean wasCurrent = client == s;
            close(s);
            if (wasCurrent) { client = null; out = null; listener.onDisconnect(); }
        }
    }

    /** Reads the HTTP upgrade request and returns the Sec-WebSocket-Key, or null if it is not a WebSocket upgrade. */
    private static String handshake(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            sb.append((char) c);
            int len = sb.length();
            if (len >= 4 && sb.charAt(len - 4) == '\r' && sb.charAt(len - 3) == '\n' && sb.charAt(len - 2) == '\r' && sb.charAt(len - 1) == '\n') break;
            if (len > 8192) return null;
        }
        for (String line : sb.toString().split("\r\n")) {
            int i = line.indexOf(':');
            if (i > 0 && line.substring(0, i).trim().equalsIgnoreCase("Sec-WebSocket-Key")) return line.substring(i + 1).trim();
        }
        return null;
    }

    private static String accept(String key) {
        try {
            byte[] sha = MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.ISO_8859_1));
            return Base64.getEncoder().encodeToString(sha);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private void readLoop(InputStream in, OutputStream o) throws IOException {
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        int messageOpcode = 0;
        while (true) {
            int b0 = in.read();
            if (b0 < 0) return;
            int b1 = in.read();
            if (b1 < 0) return;
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7f;
            if (len == 126) len = ((long) read(in) << 8) | read(in);
            else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | read(in); }
            if (len > 16 * 1024 * 1024) return;
            byte[] mask = new byte[4];
            if (masked) readFully(in, mask);
            byte[] payload = new byte[(int) len];
            readFully(in, payload);
            if (masked) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

            switch (opcode) {
                case 0x8: // close
                    return;
                case 0x9: // ping: answer with the same payload
                    synchronized (writeLock) {
                        o.write(0x8a);
                        o.write(payload.length);
                        o.write(payload);
                        o.flush();
                    }
                    break;
                case 0xa: // pong
                    break;
                default: // text, binary or continuation
                    if (opcode != 0) { message.reset(); messageOpcode = opcode; }
                    message.write(payload);
                    if (fin && messageOpcode == 0x2) listener.onMessage(message.toByteArray());
                    if (fin) message.reset();
            }
        }
    }

    private static int read(InputStream in) throws IOException {
        int v = in.read();
        if (v < 0) throw new IOException("closed");
        return v;
    }

    private static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new IOException("closed");
            off += n;
        }
    }

    private static void close(Socket s) {
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) { /* already closed */ }
    }
}
