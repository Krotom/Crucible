package frc.robot.lib.simbridge;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Binary layouts of the Crucible sim bridge (protocol 0), little-endian. Pure Java: no WPILib or Phoenix types, so it
 * can be unit tested without the HAL. The layouts are specified in Crucible/docs/NT_CONTRACT.md and mirrored by
 * app/src/engine/bridge/frames.ts.
 */
public final class FrameCodec {
    private FrameCodec() {}

    public static final int PROTOCOL = 0;
    public static final int MAGIC_TO_APP = 0x31464253; // "SBF1"
    public static final int MAGIC_FROM_APP = 0x32464253; // "SBF2"

    /** First byte of every WebSocket message: which frame follows. */
    public static final int MSG_TO_APP = 1; // robot to app
    public static final int MSG_FROM_APP = 2; // app to robot
    public static final int MSG_DS = 3;
    public static final int MSG_JOYSTICK = 4;
    public static final int MSG_POSE_SEED = 5;
    public static final int MSG_HELLO = 6; // robot to app, UTF-8 JSON
    public static final int MSG_STEP = 8; // app to robot (lockstep): u64 seq, f64 dt; the robot runs dt of simulated time and answers with ToApp(seq)
    public static final int MSG_VISION = 9; // app to robot, UTF-8 JSON: { t, tags, pose: { x, y, yaw, tags, stdXY, stdYawDeg } | null } (NT_CONTRACT section 15)
    public static final int MSG_STATS = 7; // robot to app: f64 average round trip us, f64 max round trip us, i64 stale ticks

    public static final int TO_APP_HEADER_BYTES = 36;
    public static final int TO_APP_MOTOR_BYTES = 16;
    public static final int FROM_APP_HEADER_BYTES = 40;
    public static final int FROM_APP_MOTOR_BYTES = 28;
    public static final int FROM_APP_CANCODER_BYTES = 28;
    public static final int FROM_APP_PIGEON_BYTES = 76;
    public static final int FROM_APP_DIO_BYTES = 8;

    /** Per-motor flag in ToApp: the robot code re-zeroed the motor position, the app resets its physics state. */
    public static final int MOTOR_FLAG_RESET = 4;

    public static final int FLAG_ENABLED = 1;
    public static final int FLAG_BROWNOUT = 2;

    public record Motor(int id, double appliedVolts, int flags) {}

    public record MotorState(int id, double rotorPositionRot, double rotorVelocityRps, double rotorAccelRps2) {}

    public record CancoderState(int id, double positionRot, double velocityRps, double absolutePositionRot) {}

    /** yaw, pitch, roll in degrees; rates in deg/s; accelerations in g. */
    public record PigeonState(int id, double yawDeg, double pitchDeg, double rollDeg, double yawRateDps,
            double pitchRateDps, double rollRateDps, double accelXg, double accelYg, double accelZg) {}

    public record FromApp(long seq, double simTime, double batteryVolts, MotorState[] motors,
            CancoderState[] cancoders, PigeonState[] pigeons, int digitalInputs) {}

    /** Control/DS: the Driver Station state the app wants the robot to see. */
    /** gameData is the character of the Game Data string (for example 'R' or 'B' in 2026), 0 when none has been sent. */
    public record DsState(long counter, int flags, int alliance, int station, int gameData, double matchTime) {
        public static final int ENABLED = 1, AUTONOMOUS = 2, TEST = 4, ESTOP = 8, DS_ATTACHED = 16;
        public boolean enabled() { return (flags & ENABLED) != 0; }
        public boolean autonomous() { return (flags & AUTONOMOUS) != 0; }
        public boolean test() { return (flags & TEST) != 0; }
        public boolean estop() { return (flags & ESTOP) != 0; }
        public boolean dsAttached() { return (flags & DS_ATTACHED) != 0; }
    }

    /** Control/Joystick/N: up to 6 axes, up to 64 buttons, one POV. */
    public record JoystickState(long counter, double[] axes, long buttons, int pov) {}

    /** Control/PoseSeed: ask the robot to reset its odometry pose. */
    public record PoseSeed(long counter, double x, double y, double yawRad) {}

    private static ByteBuffer wrap(byte[] b) { return ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN); }

    public static byte[] encodeToApp(long seq, double simTime, double batteryVolts, int flags, Motor[] motors) {
        ByteBuffer b = ByteBuffer.allocate(TO_APP_HEADER_BYTES + TO_APP_MOTOR_BYTES * motors.length)
                .order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(MAGIC_TO_APP).putInt(PROTOCOL).putLong(seq).putDouble(simTime).putDouble(batteryVolts)
                .putShort((short) motors.length).putShort((short) flags);
        for (Motor m : motors) b.putInt(m.id()).putDouble(m.appliedVolts()).putInt(m.flags());
        return b.array();
    }

    /** Decodes a FromApp frame; returns null when the bytes are not a valid protocol-0 frame. */
    public static FromApp decodeFromApp(byte[] bytes) {
        if (bytes == null || bytes.length < FROM_APP_HEADER_BYTES) return null;
        ByteBuffer b = wrap(bytes);
        if (b.getInt() != MAGIC_FROM_APP || b.getInt() != PROTOCOL) return null;
        long seq = b.getLong();
        double simTime = b.getDouble();
        double battery = b.getDouble();
        int nm = b.getShort() & 0xffff, nc = b.getShort() & 0xffff, np = b.getShort() & 0xffff, nd = b.getShort() & 0xffff;
        long need = FROM_APP_HEADER_BYTES + (long) nm * FROM_APP_MOTOR_BYTES + (long) nc * FROM_APP_CANCODER_BYTES
                + (long) np * FROM_APP_PIGEON_BYTES + (long) nd * FROM_APP_DIO_BYTES;
        if (bytes.length < need) return null;
        MotorState[] motors = new MotorState[nm];
        for (int i = 0; i < nm; i++) motors[i] = new MotorState(b.getInt(), b.getDouble(), b.getDouble(), b.getDouble());
        CancoderState[] cans = new CancoderState[nc];
        for (int i = 0; i < nc; i++) cans[i] = new CancoderState(b.getInt(), b.getDouble(), b.getDouble(), b.getDouble());
        PigeonState[] pigs = new PigeonState[np];
        for (int i = 0; i < np; i++) {
            pigs[i] = new PigeonState(b.getInt(), b.getDouble(), b.getDouble(), b.getDouble(), b.getDouble(),
                    b.getDouble(), b.getDouble(), b.getDouble(), b.getDouble(), b.getDouble());
        }
        return new FromApp(seq, simTime, battery, motors, cans, pigs, nd);
    }

    public static DsState decodeDs(byte[] bytes) {
        if (bytes == null || bytes.length < 24) return null;
        ByteBuffer b = wrap(bytes);
        long counter = b.getLong();
        int flags = b.getInt();
        int alliance = b.get() & 0xff;
        int station = b.get() & 0xff;
        int gameData = b.get() & 0xff;
        b.get();
        return new DsState(counter, flags, alliance, station, gameData, b.getDouble());
    }

    public static byte[] encodeDs(DsState s) {
        ByteBuffer b = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
        b.putLong(s.counter()).putInt(s.flags()).put((byte) s.alliance()).put((byte) s.station()).put((byte) s.gameData()).put((byte) 0)
                .putDouble(s.matchTime());
        return b.array();
    }

    public static JoystickState decodeJoystick(byte[] bytes) {
        if (bytes == null || bytes.length < 72) return null;
        ByteBuffer b = wrap(bytes);
        long counter = b.getLong();
        double[] axes = new double[6];
        for (int i = 0; i < 6; i++) axes[i] = b.getDouble();
        long buttons = b.getLong();
        return new JoystickState(counter, axes, buttons, b.getShort());
    }

    public static PoseSeed decodePoseSeed(byte[] bytes) {
        if (bytes == null || bytes.length < 32) return null;
        ByteBuffer b = wrap(bytes);
        return new PoseSeed(b.getLong(), b.getDouble(), b.getDouble(), b.getDouble());
    }
}
