package frc.robot.lib.simbridge;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import com.ctre.phoenix6.configs.CANcoderConfiguration;
import com.ctre.phoenix6.sim.CANcoderSimState;
import com.ctre.phoenix6.sim.ChassisReference;
import com.ctre.phoenix6.sim.Pigeon2SimState;
import com.ctre.phoenix6.sim.TalonFXSimState;
import com.ctre.phoenix6.swerve.SwerveModuleConstants;
import com.ctre.phoenix6.unmanaged.Unmanaged;

import edu.wpi.first.hal.AllianceStationID;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.networktables.IntegerPublisher;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StringPublisher;
import edu.wpi.first.wpilibj.Notifier;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import com.ctre.phoenix6.hardware.CANcoder;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.swerve.SwerveDrivetrain;

/**
 * Robot side of the Crucible sim bridge (simulation only). Every exchange period it sends the applied voltage of the
 * bridged motors as one packed ToApp frame and applies each FromApp frame (rotor, CANcoder and Pigeon states from the app's
 * physics) to the Phoenix sim states the moment it arrives, so the Talon control loops keep running in this process while
 * the app owns the physics. Driver Station, joystick and pose-seed controls arrive on the same channel.
 *
 * The channel is a local WebSocket (WsServer, port 5811), not NetworkTables: NT batches updates in tens of milliseconds,
 * and that delay makes the high-gain mechanism loops ring. NT still carries the human-visible topics (Hello, Heartbeat,
 * Debug) for AdvantageScope.
 *
 * Off unless the environment variable CRUCIBLE_BRIDGE=1 (or the system property crucible.bridge) is set; the app sets it
 * when it launches the robot. Protocol and messages: Crucible/docs/NT_CONTRACT.md.
 */
public final class SimBridge {
    private static final String ROOT = "/SimBridge/main/";
    private static final int WS_PORT = 5811;
    private static final double PERIOD_S = 0.005;
    private static final int RESET_TICKS = 4; // ToApp frames that carry a reset request
    private static SimBridge instance;

    public static boolean isEnabled() {
        return "1".equals(System.getenv("CRUCIBLE_BRIDGE")) || Boolean.getBoolean("crucible.bridge");
    }

    /**
     * Lockstep (Mode B): the app owns the clock. The robot's time is paused and advances only when the app sends a Step, the Talons are
     * the Java emulation (EmuTalon) and the swerve layer is EmuSwerve, so a run is repeatable and can go faster than real time.
     * Set by CRUCIBLE_MODE=lockstep together with CRUCIBLE_BRIDGE=1.
     */
    public static boolean isLockstep() {
        return isEnabled() && ("lockstep".equals(System.getenv("CRUCIBLE_MODE")) || Boolean.getBoolean("crucible.lockstep"));
    }

    private static synchronized SimBridge get() {
        if (instance == null) instance = new SimBridge();
        return instance;
    }

    /**
     * Registers a simulated mechanism motor (called by TalonFXSim when the bridge is on): the app, not a DCMotorSim, then
     * moves it. The description goes into the Hello message so the app can check its robot definition against the code.
     */
    public static void registerMechanism(int id, TalonFXSimState sim, String motorType, int motorCount, double sensorToMechanism,
            double inertiaKgM2) {
        SimBridge b = get();
        b.motors.add(new MotorHandle(id, sim));
        b.mechanisms.add(new MechanismInfo(id, motorType, motorCount, sensorToMechanism, inertiaKgM2));
        b.publishHello();
    }

    /** Lockstep: registers an emulated mechanism motor. */
    public static void registerEmu(EmuTalon t) {
        SimBridge b = get();
        b.emus.add(t);
        b.mechanisms.add(new MechanismInfo(t.id(), t.motorName(), t.motorCount(), t.ratio(), t.inertia()));
        b.publishHello();
    }

    /** Lockstep: the swerve layer's motors and sensors (its motors are registered with registerEmu, without mechanism info). */
    public static void registerEmuDevice(EmuTalon t) {
        SimBridge b = get();
        b.emus.add(t);
        b.publishHello();
    }

    /** Lockstep: the drivetrain layer receives each FromApp frame (CANcoder and Pigeon states) and is told when a step has been taken. */
    public interface LockstepDevice {
        void applyFromApp(FrameCodec.FromApp f);

        void seedPose(double x, double y, double yawRad);

        /** Before the Talons compute their voltages for the next step of dt seconds. */
        void step(double dt);
    }

    /** Lockstep: the swerve layer's CANcoder and Pigeon, so the Hello message lists them. */
    public static void registerEmuCancoder(int id) { SimBridge b = get(); b.emuCancoderIds.add(id); b.publishHello(); }

    public static void registerEmuPigeon(int id) { SimBridge b = get(); b.emuPigeonIds.add(id); b.publishHello(); }

    public static synchronized void installLockstep(LockstepDevice device) {
        SimBridge b = get();
        if (b.started) return;
        SimHooks.pauseTiming(); // the app advances the clock from here on (the loop's alarms are set from the paused time, so their phase against the steps is the same every run: the first Step waits for the loop)
        b.lockstepDevice = device;
        b.start();
    }

    /** The mechanism's code re-zeroed its motor position: tell the app to zero its physics state too. */
    public static void requestReset(int id) {
        if (instance != null) instance.resetTicks.put(id, RESET_TICKS);
    }

    /**
     * Registers the swerve drivetrain's motors, CANcoders and Pigeon, and starts the bridge. Pass the module constants in the order of the modules
     * (for Tuner X generated code: TunerConstants.FrontLeft, FrontRight, BackLeft, BackRight); they say how each device is inverted.
     */
    public static synchronized void installSwerve(SwerveDrivetrain<TalonFX, TalonFX, CANcoder> dt, SwerveModuleConstants<?, ?, ?>... constants) {
        SimBridge b = get();
        if (b.started) return;
        b.addSwerve(dt, constants);
        b.start();
    }

    private record MotorHandle(int id, TalonFXSimState sim) {}

    private record MechanismInfo(int id, String motor, int count, double ratio, double inertia) {}

    private record CancoderHandle(int id, CANcoderSimState sim, double magnetOffsetRot) {}

    private record PigeonHandle(int id, Pigeon2SimState sim) {}

    private final List<MotorHandle> motors = new CopyOnWriteArrayList<>();
    private final List<EmuTalon> emus = new CopyOnWriteArrayList<>();
    private final List<Integer> emuCancoderIds = new CopyOnWriteArrayList<>();
    private final List<Integer> emuPigeonIds = new CopyOnWriteArrayList<>();
    private LockstepDevice lockstepDevice;
    private final boolean lockstep = isLockstep();
    private final List<CancoderHandle> cancoders = new CopyOnWriteArrayList<>();
    private final List<PigeonHandle> pigeons = new CopyOnWriteArrayList<>();
    private final List<MechanismInfo> mechanisms = new CopyOnWriteArrayList<>();
    private final Map<Integer, Integer> resetTicks = new ConcurrentHashMap<>();
    private volatile boolean started = false;
    private SwerveDrivetrain<TalonFX, TalonFX, CANcoder> drivetrain;

    private final NetworkTableInstance nt = NetworkTableInstance.getDefault();
    private IntegerPublisher heartbeat;
    private IntegerPublisher staleTicks;
    private IntegerPublisher rttAvgPub;
    private StringPublisher helloPub;
    private WsServer ws;
    private Notifier notifier;

    private long seq = 0;
    private volatile long lastFromSeq = -1;
    private long seqAtLastTick = -2;
    private long stale = 0;
    private long beat = 0;
    private long lastDsCounter = -1;
    private long lastJoyCounter = -1;
    private long lastSeedCounter = -1;
    private int ticks = 0;

    /** nanoTime at which each ToApp frame was sent (by seq mod 256), to time the round trip of its answer */
    private final long[] sentNanos = new long[256];
    private long rttSumUs = 0;
    private long rttCount = 0;
    private long rttMaxUs = 0;

    private void addSwerve(SwerveDrivetrain<TalonFX, TalonFX, CANcoder> dt, SwerveModuleConstants<?, ?, ?>[] constants) {
        drivetrain = dt;
        if (constants.length != dt.getModules().length) throw new IllegalArgumentException("installSwerve needs one SwerveModuleConstants per module (" + dt.getModules().length + "), got " + constants.length);
        for (int i = 0; i < constants.length; i++) {
            var module = dt.getModule(i);
            var c = constants[i];
            TalonFXSimState drive = module.getDriveMotor().getSimState();
            TalonFXSimState steer = module.getSteerMotor().getSimState();
            CANcoderSimState enc = module.getEncoder().getSimState();
            // positive means the module's own forward / counterclockwise whatever the inversion, as in CTRE's own sim
            drive.Orientation = c.DriveMotorInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
            steer.Orientation = c.SteerMotorInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
            enc.Orientation = c.EncoderInverted ? ChassisReference.Clockwise_Positive : ChassisReference.CounterClockwise_Positive;
            drive.setMotorType(TalonFXSimState.MotorType.KrakenX60);
            steer.setMotorType(TalonFXSimState.MotorType.KrakenX60);
            // the CANcoder reports raw + MagnetOffset, so the raw value to set is azimuth - MagnetOffset (spike S4)
            CANcoderConfiguration cfg = new CANcoderConfiguration();
            module.getEncoder().getConfigurator().refresh(cfg);
            motors.add(new MotorHandle(module.getDriveMotor().getDeviceID(), drive));
            motors.add(new MotorHandle(module.getSteerMotor().getDeviceID(), steer));
            cancoders.add(new CancoderHandle(module.getEncoder().getDeviceID(), enc, cfg.MagnetSensor.MagnetOffset));
        }
        pigeons.add(new PigeonHandle(dt.getPigeon2().getDeviceID(), dt.getPigeon2().getSimState()));
    }

    private void start() {
        heartbeat = nt.getIntegerTopic(ROOT + "Heartbeat").publish();
        staleTicks = nt.getIntegerTopic(ROOT + "Debug/StaleTicks").publish();
        rttAvgPub = nt.getIntegerTopic(ROOT + "Debug/RttAvgUs").publish();
        helloPub = nt.getStringTopic(ROOT + "Hello").publish();
        ws = new WsServer(WS_PORT, new WsServer.Listener() {
            @Override public void onConnect() { lastFromSeq = -1; sendHello(); }

            @Override public void onMessage(byte[] m) { onWsMessage(m); }

            @Override public void onDisconnect() { /* the next tick simply finds nobody to send to */ }
        });
        try {
            ws.start();
        } catch (IOException e) {
            edu.wpi.first.wpilibj.DriverStation.reportError("SimBridge could not listen on port " + WS_PORT + ": " + e, false);
        }
        started = true;
        publishHello();
        if (lockstep) return; // no timer: every exchange is a Step from the app
        notifier = new Notifier(this::tick);
        notifier.setName("CrucibleBridge");
        notifier.startPeriodic(PERIOD_S);
    }

    private synchronized void publishHello() {
        if (!started) return;
        helloPub.set(helloJson());
        sendHello();
    }

    private void sendHello() {
        if (ws != null) ws.send(prefixed(FrameCodec.MSG_HELLO, helloJson().getBytes(StandardCharsets.UTF_8)));
    }

    private String helloJson() {
        StringBuilder sb = new StringBuilder("{\"protocol\":" + FrameCodec.PROTOCOL
                + ",\"name\":\"" + edu.wpi.first.wpilibj.Filesystem.getLaunchDirectory().getName() + "\",\"modes\":[\"" + (lockstep ? "lockstep" : "realtime") + "\"],\"exchangePeriodMs\":" + (int) (PERIOD_S * 1000)
                + ",\"transport\":\"ws://127.0.0.1:" + WS_PORT + "\",\"devices\":[");
        boolean first = true;
        for (MotorHandle m : motors) { sb.append(first ? "" : ",").append("{\"type\":\"talonfx\",\"id\":").append(m.id()).append('}'); first = false; }
        for (EmuTalon e : emus) { sb.append(first ? "" : ",").append("{\"type\":\"talonfx\",\"id\":").append(e.id()).append('}'); first = false; }
        for (int id : emuCancoderIds) { sb.append(first ? "" : ",").append("{\"type\":\"cancoder\",\"id\":").append(id).append('}'); first = false; }
        for (int id : emuPigeonIds) { sb.append(first ? "" : ",").append("{\"type\":\"pigeon2\",\"id\":").append(id).append('}'); first = false; }
        for (CancoderHandle c : cancoders) { sb.append(",{\"type\":\"cancoder\",\"id\":").append(c.id()).append('}'); }
        for (PigeonHandle p : pigeons) { sb.append(",{\"type\":\"pigeon2\",\"id\":").append(p.id()).append('}'); }
        sb.append("],\"mechanisms\":[");
        first = true;
        for (MechanismInfo m : mechanisms) {
            sb.append(first ? "" : ",").append(String.format(java.util.Locale.ROOT,
                    "{\"id\":%d,\"motor\":\"%s\",\"count\":%d,\"ratio\":%s,\"inertia\":%s}", m.id(), m.motor(), m.count(), m.ratio(), m.inertia()));
            first = false;
        }
        return sb.append("]}").toString();
    }

    private static byte[] prefixed(int type, byte[] payload) {
        byte[] out = new byte[payload.length + 1];
        out[0] = (byte) type;
        System.arraycopy(payload, 0, out, 1, payload.length);
        return out;
    }

    private void tick() {
        try {
            if (lastFromSeq == seqAtLastTick) stale++;
            seqAtLastTick = lastFromSeq;
            if (DriverStationSim.getEnabled()) Unmanaged.feedEnable(100);
            double battery = RobotController.getBatteryVoltage();
            for (MotorHandle h : motors) h.sim().setSupplyVoltage(battery);
            publishToApp();
            if (++ticks % 20 == 0) { // 100 ms
                heartbeat.set(++beat);
                staleTicks.set(stale);
                synchronized (this) {
                    long avg = rttCount == 0 ? 0 : rttSumUs / rttCount;
                    rttAvgPub.set(avg);
                    ByteBuffer b = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
                    b.putDouble(avg).putDouble(rttMaxUs).putLong(stale);
                    ws.send(prefixed(FrameCodec.MSG_STATS, b.array()));
                    rttSumUs = 0; rttCount = 0; rttMaxUs = 0;
                }
            }
        } catch (RuntimeException e) {
            edu.wpi.first.wpilibj.DriverStation.reportError("SimBridge tick failed: " + e, e.getStackTrace());
        }
    }

    private void publishToApp() {
        if (!ws.connected()) return;
        int n = motors.size();
        FrameCodec.Motor[] m = new FrameCodec.Motor[n + emus.size()];
        for (int i = 0; i < n; i++) {
            var h = motors.get(i);
            m[i] = new FrameCodec.Motor(h.id(), h.sim().getMotorVoltage(), takeResetFlag(h.id()));
        }
        for (int i = 0; i < emus.size(); i++) {
            var e = emus.get(i);
            m[n + i] = new FrameCodec.Motor(e.id(), e.appliedVolts(), takeResetFlag(e.id()));
        }
        int flags = (DriverStationSim.getEnabled() ? FrameCodec.FLAG_ENABLED : 0) | (RobotController.isBrownedOut() ? FrameCodec.FLAG_BROWNOUT : 0);
        sentNanos[(int) (seq & 255)] = System.nanoTime();
        ws.send(prefixed(FrameCodec.MSG_TO_APP,
                FrameCodec.encodeToApp(seq++, Timer.getFPGATimestamp(), RobotController.getBatteryVoltage(), flags, m)));
    }

    /** Bit 2 of the motor flags: the code zeroed this motor's position (held for a few frames, the app acts on the rising edge). */
    private int takeResetFlag(int id) {
        Integer left = resetTicks.get(id);
        if (left == null) return 0;
        if (left <= 1) resetTicks.remove(id); else resetTicks.put(id, left - 1);
        return FrameCodec.MOTOR_FLAG_RESET;
    }

    // ------------------------------------------------------------------ messages from the app (WebSocket thread)

    private void onWsMessage(byte[] m) {
        if (m.length < 2) return;
        byte[] body = java.util.Arrays.copyOfRange(m, 1, m.length);
        try {
            switch (m[0]) {
                case FrameCodec.MSG_FROM_APP -> applyFromApp(body);
                case FrameCodec.MSG_STEP -> onStep(body);
                case FrameCodec.MSG_DS -> applyDs(FrameCodec.decodeDs(body));
                case FrameCodec.MSG_JOYSTICK -> applyJoystick(FrameCodec.decodeJoystick(body));
                case FrameCodec.MSG_POSE_SEED -> applySeed(FrameCodec.decodePoseSeed(body));
                default -> { /* unknown message types are ignored */ }
            }
        } catch (RuntimeException e) {
            edu.wpi.first.wpilibj.DriverStation.reportError("SimBridge message failed: " + e, e.getStackTrace());
        }
    }

    private synchronized void applyFromApp(byte[] bytes) {
        FrameCodec.FromApp f = FrameCodec.decodeFromApp(bytes);
        if (f == null || f.seq() == lastFromSeq) return;
        lastFromSeq = f.seq();
        long sent = sentNanos[(int) (f.seq() & 255)];
        if (sent != 0 && seq - f.seq() < 256) {
            long us = (System.nanoTime() - sent) / 1000;
            rttSumUs += us; rttCount++; rttMaxUs = Math.max(rttMaxUs, us);
        }
        for (var s : f.motors()) {
            for (MotorHandle h : motors) {
                if (h.id() == s.id()) {
                    h.sim().setRawRotorPosition(s.rotorPositionRot());
                    h.sim().setRotorVelocity(s.rotorVelocityRps());
                    h.sim().setRotorAcceleration(s.rotorAccelRps2());
                }
            }
        }
        for (var s : f.motors()) {
            for (EmuTalon e : emus) if (e.id() == s.id()) e.applyRotor(s.rotorPositionRot(), s.rotorVelocityRps(), s.rotorAccelRps2());
        }
        if (lockstepDevice != null) lockstepDevice.applyFromApp(f);
        for (var s : f.cancoders()) {
            for (CancoderHandle h : cancoders) {
                if (h.id() == s.id()) {
                    h.sim().setRawPosition(s.positionRot() - h.magnetOffsetRot());
                    h.sim().setVelocity(s.velocityRps());
                }
            }
        }
        for (var s : f.pigeons()) {
            for (PigeonHandle h : pigeons) {
                if (h.id() == s.id()) {
                    h.sim().setRawYaw(s.yawDeg());
                    h.sim().setPitch(s.pitchDeg());
                    h.sim().setRoll(s.rollDeg());
                    h.sim().setAngularVelocityZ(s.yawRateDps());
                    h.sim().setAngularVelocityY(s.pitchRateDps());
                    h.sim().setAngularVelocityX(s.rollRateDps());
                }
            }
        }
    }

    // ------------------------------------------------------------------ lockstep

    /**
     * Step(seq, dt): run dt of simulated time (every notifier, the robot loop and the subsystems run inside stepTiming), let the emulated
     * Talons compute their voltages from the newest requests and the rotor state the app last returned, and answer with ToApp(seq).
     */
    private void onStep(byte[] body) {
        if (!lockstep || body.length < 16) return;
        if (!stepping) {
            // the robot loop must have created its alarm before the clock moves, or its phase would depend on how many steps came first
            while (!robotStarted) sleepQuietly(5);
            // the loop may run its first iteration at once (its alarm is already due), concurrently with the first steps: wait for it
            long t0 = System.nanoTime();
            while (loopIterations == 0 && System.nanoTime() - t0 < 4_000_000_000L) sleepQuietly(5);
            sleepQuietly(300);
            stepping = true;
        }
        ByteBuffer b = ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN);
        long stepSeq = b.getLong();
        double dt = b.getDouble();
        SimHooks.stepTiming(dt);
        if (lockstepDevice != null) lockstepDevice.step(dt);
        for (EmuTalon e : emus) e.update(dt);
        seq = stepSeq;
        publishToApp();
        seq = stepSeq + 1;
    }

    private volatile boolean robotStarted = false;
    private volatile int loopIterations = 0;

    /** Robot.robotPeriodic(): the loop has run an iteration. */
    public static void markLoopIteration() { get().loopIterations++; }
    private boolean stepping = false;

    /** Robot.simulationInit(): from here the robot loop sets its first alarm; the first Step waits for it. */
    public static void markRobotStarted() { get().robotStarted = true; }

    private static void sleepQuietly(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private void applyDs(FrameCodec.DsState ds) {
        if (ds == null || ds.counter() == lastDsCounter) return;
        lastDsCounter = ds.counter();
        DriverStationSim.setDsAttached(ds.dsAttached());
        DriverStationSim.setEStop(ds.estop());
        DriverStationSim.setAutonomous(ds.autonomous());
        DriverStationSim.setTest(ds.test());
        DriverStationSim.setEnabled(ds.enabled());
        DriverStationSim.setAllianceStationId(allianceStation(ds.alliance(), ds.station()));
        DriverStationSim.setMatchTime(ds.matchTime());
        // the field system's Game Data (the 2026 game sends one character, the alliance whose HUB goes inactive first)
        DriverStationSim.setGameSpecificMessage(ds.gameData() == 0 ? "" : String.valueOf((char) ds.gameData()));
        DriverStationSim.notifyNewData();
    }

    private void applyJoystick(FrameCodec.JoystickState joy) {
        if (joy == null || joy.counter() == lastJoyCounter) return;
        lastJoyCounter = joy.counter();
        DriverStationSim.setJoystickAxisCount(0, 6);
        DriverStationSim.setJoystickButtonCount(0, 10);
        DriverStationSim.setJoystickPOVCount(0, 1);
        for (int i = 0; i < 6; i++) DriverStationSim.setJoystickAxis(0, i, joy.axes()[i]);
        DriverStationSim.setJoystickButtons(0, (int) joy.buttons());
        DriverStationSim.setJoystickPOV(0, 0, joy.pov());
        DriverStationSim.notifyNewData();
    }

    private void applySeed(FrameCodec.PoseSeed seed) {
        if (seed == null || seed.counter() == lastSeedCounter || (drivetrain == null && lockstepDevice == null)) return;
        lastSeedCounter = seed.counter();
        if (lockstepDevice != null) { lockstepDevice.seedPose(seed.x(), seed.y(), seed.yawRad()); return; }
        drivetrain.resetPose(new Pose2d(seed.x(), seed.y(), Rotation2d.fromRadians(seed.yawRad())));
    }

    private static AllianceStationID allianceStation(int alliance, int station) {
        boolean blue = alliance == 1;
        return switch (station) {
            case 2 -> blue ? AllianceStationID.Blue2 : AllianceStationID.Red2;
            case 3 -> blue ? AllianceStationID.Blue3 : AllianceStationID.Red3;
            default -> blue ? AllianceStationID.Blue1 : AllianceStationID.Red1;
        };
    }
}
