package frc.robot.lib.simbridge;

import java.util.Optional;

import com.ctre.phoenix6.configs.TalonFXConfiguration;
import com.ctre.phoenix6.swerve.SwerveDrivetrain.SwerveDriveState;
import com.ctre.phoenix6.swerve.SwerveDrivetrainConstants;
import com.ctre.phoenix6.swerve.SwerveModuleConstants;
import com.ctre.phoenix6.swerve.SwerveRequest;

import edu.wpi.first.math.Matrix;
import edu.wpi.first.math.VecBuilder;
import edu.wpi.first.math.estimator.SwerveDrivePoseEstimator;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.math.kinematics.SwerveDriveKinematics;
import edu.wpi.first.math.kinematics.SwerveModulePosition;
import edu.wpi.first.math.kinematics.SwerveModuleState;
import edu.wpi.first.math.numbers.N1;
import edu.wpi.first.math.numbers.N3;
import edu.wpi.first.math.system.plant.DCMotor;
import edu.wpi.first.wpilibj.Timer;

/**
 * The swerve drivetrain for lockstep (Mode B), replacing the CTRE drivetrain's own module control and odometry thread (which run against
 * the wall clock). It does what the CTRE drivetrain does for the requests the robot uses: field-centric (operator perspective, deadbands),
 * robot-centric and robot-speed (PathPlanner) requests become module states (cosine compensation, optimization, wheel-speed desaturation),
 * the drive motors get an open-loop voltage (or a velocity loop) and the steer motors a position loop, both on {@link EmuTalon}s with the
 * module constants' own gains. Odometry is a WPILib pose estimator updated once per exchange from the rotor and CANcoder states the app's
 * physics returned and the Pigeon yaw, with vision measurements applied at their timestamps. All of it runs in simulated time.
 *
 * Follows the request logic of the CTRE swerve module (state.optimize, cosineScale, backing the coupled azimuth rate out of the drive
 * velocity, open-loop volts = speed / speedAt12Volts * 12). Not modeled: wheel force feedforwards, MotionMagicExpo steering, closed-loop
 * drive requests beyond a plain velocity loop, and the CTRE module-level state signals (a module state is computed from the rotor).
 */
public final class EmuSwerve implements SimBridge.LockstepDevice {
    private static final double UPDATE_PERIOD = 0.004; // the CTRE odometry rate, used for discretizing the request

    private final int n;
    private final EmuTalon[] drive;
    private final EmuTalon[] steer;
    private final int[] encoderIds;
    private final double[] driveRotationsPerMeter;
    private final double[] coupling;
    private final double[] speedAt12;
    private final SwerveDriveKinematics kinematics;
    private final Translation2d[] locations;
    private final int pigeonId;
    private final SwerveDrivePoseEstimator estimator;

    private final double[] azimuthRot;
    private final double[] azimuthRps;
    private final double[] driveRotorPos;
    private final double[] driveRotorVel;
    private double yawDeg;
    private double yawRateDps;
    private double lastEstimatorTime = Double.NaN;

    private SwerveRequest request = new SwerveRequest.Idle();
    private Rotation2d operatorForward = Rotation2d.kZero;
    private SwerveModuleState[] targets;
    private SwerveDriveState state = new SwerveDriveState();
    private int daqs;

    public EmuSwerve(SwerveDrivetrainConstants dc, SwerveModuleConstants<?, ?, ?>[] modules, int pigeonId) {
        n = modules.length;
        this.pigeonId = pigeonId;
        drive = new EmuTalon[n];
        steer = new EmuTalon[n];
        encoderIds = new int[n];
        driveRotationsPerMeter = new double[n];
        coupling = new double[n];
        speedAt12 = new double[n];
        locations = new Translation2d[n];
        azimuthRot = new double[n];
        azimuthRps = new double[n];
        driveRotorPos = new double[n];
        driveRotorVel = new double[n];
        for (int i = 0; i < n; i++) {
            var c = modules[i];
            TalonFXConfiguration dcfg = new TalonFXConfiguration();
            copyGains(dcfg, c.DriveMotorGains);
            dcfg.Feedback.SensorToMechanismRatio = c.DriveMotorGearRatio;
            dcfg.CurrentLimits.StatorCurrentLimit = c.SlipCurrent;
            dcfg.CurrentLimits.StatorCurrentLimitEnable = true;
            TalonFXConfiguration scfg = new TalonFXConfiguration();
            copyGains(scfg, c.SteerMotorGains);
            scfg.Feedback.SensorToMechanismRatio = c.SteerMotorGearRatio;
            scfg.CurrentLimits.StatorCurrentLimit = 60; // TunerConstants' steer limit
            scfg.CurrentLimits.StatorCurrentLimitEnable = true;
            drive[i] = new EmuTalon(c.DriveMotorId, dcfg, DCMotor.getKrakenX60(1), 1, c.DriveInertia, "krakenX60");
            steer[i] = new EmuTalon(c.SteerMotorId, scfg, DCMotor.getKrakenX60(1), 1, c.SteerInertia, "krakenX60");
            steer[i].setContinuousWrap(true);
            SimBridge.registerEmuDevice(drive[i]);
            SimBridge.registerEmuDevice(steer[i]);
            SimBridge.registerEmuCancoder(c.EncoderId);
            encoderIds[i] = c.EncoderId;
            driveRotationsPerMeter[i] = c.DriveMotorGearRatio / (2 * Math.PI * c.WheelRadius);
            coupling[i] = c.CouplingGearRatio;
            speedAt12[i] = c.SpeedAt12Volts;
            locations[i] = new Translation2d(c.LocationX, c.LocationY);
        }
        SimBridge.registerEmuPigeon(pigeonId);
        kinematics = new SwerveDriveKinematics(locations);
        estimator = new SwerveDrivePoseEstimator(kinematics, Rotation2d.kZero, positions(), new Pose2d(),
                VecBuilder.fill(0.1, 0.1, 0.1), VecBuilder.fill(0.9, 0.9, 0.9));
        targets = new SwerveModuleState[n];
        for (int i = 0; i < n; i++) targets[i] = new SwerveModuleState();
        refreshState();
    }

    private static void copyGains(TalonFXConfiguration cfg, com.ctre.phoenix6.configs.Slot0Configs g) {
        cfg.Slot0.kP = g.kP; cfg.Slot0.kI = g.kI; cfg.Slot0.kD = g.kD; cfg.Slot0.kS = g.kS; cfg.Slot0.kV = g.kV; cfg.Slot0.kA = g.kA;
    }

    public SwerveDriveKinematics kinematics() { return kinematics; }

    // ------------------------------------------------------------------ what the robot code calls (robot thread)

    public synchronized void setControl(SwerveRequest r) { request = r; }

    public synchronized SwerveDriveState state() {
        SwerveDriveState s = new SwerveDriveState();
        s.Pose = state.Pose; s.Speeds = state.Speeds; s.ModuleStates = state.ModuleStates; s.ModuleTargets = state.ModuleTargets;
        s.ModulePositions = state.ModulePositions; s.RawHeading = state.RawHeading; s.Timestamp = state.Timestamp;
        s.OdometryPeriod = state.OdometryPeriod; s.SuccessfulDaqs = state.SuccessfulDaqs; s.FailedDaqs = state.FailedDaqs;
        return s;
    }

    public synchronized void resetPose(Pose2d pose) {
        estimator.resetPosition(rawHeading(), positions(), pose);
        refreshState();
    }

    public synchronized void addVisionMeasurement(Pose2d pose, double timestampSeconds, Matrix<N3, N1> stdDevs) {
        estimator.addVisionMeasurement(pose, timestampSeconds, stdDevs);
        refreshState();
    }

    public synchronized Optional<Pose2d> samplePoseAt(double timestampSeconds) { return estimator.sampleAt(timestampSeconds); }

    public synchronized void setOperatorPerspectiveForward(Rotation2d fieldDirection) { operatorForward = fieldDirection; }

    public synchronized double yawRateDegPerSec() { return yawRateDps; }

    // ------------------------------------------------------------------ the exchange (WebSocket thread)

    @Override
    public synchronized void applyFromApp(FrameCodec.FromApp f) {
        for (var s : f.motors()) {
            for (int i = 0; i < n; i++) {
                if (drive[i].id() == s.id()) { driveRotorPos[i] = s.rotorPositionRot(); driveRotorVel[i] = s.rotorVelocityRps(); }
            }
        }
        for (var c : f.cancoders()) {
            for (int i = 0; i < n; i++) if (encoderIds[i] == c.id()) { azimuthRot[i] = c.positionRot(); azimuthRps[i] = c.velocityRps(); }
        }
        for (var p : f.pigeons()) if (p.id() == pigeonId) { yawDeg = p.yawDeg(); yawRateDps = p.yawRateDps(); }
        double now = Timer.getFPGATimestamp();
        estimator.updateWithTime(now, rawHeading(), positions());
        lastEstimatorTime = now;
        refreshState();
    }

    @Override
    public synchronized void seedPose(double x, double y, double yawRad) { resetPose(new Pose2d(x, y, Rotation2d.fromRadians(yawRad))); }

    /** Before the Talons compute their voltages for the next step: turn the standing request into module targets and controls. */
    @Override
    public synchronized void step(double dt) {
        SwerveModuleState[] t = moduleTargets();
        boolean closedLoopDrive = driveRequestIsVelocity();
        for (int i = 0; i < n; i++) {
            if (t == null) {
                // Idle: no output
                drive[i].setVoltage(0);
                steer[i].stop();
                targets[i] = new SwerveModuleState(0, currentAngle(i));
                continue;
            }
            SwerveModuleState s = new SwerveModuleState(t[i].speedMetersPerSecond, t[i].angle);
            Rotation2d angle = currentAngle(i);
            s.optimize(angle);
            s.cosineScale(angle);
            targets[i] = new SwerveModuleState(s.speedMetersPerSecond, s.angle);
            steer[i].setPosition(s.angle.getRotations());
            // back the azimuth's coupling into the drive wheel out of the velocity to set (rotor rotations per second)
            double velocityToSet = s.speedMetersPerSecond * driveRotationsPerMeter[i] - azimuthRps[i] * coupling[i];
            if (closedLoopDrive) drive[i].setVelocity(velocityToSet / drive[i].ratio());
            else drive[i].setVoltage(velocityToSet / (speedAt12[i] * driveRotationsPerMeter[i]) * 12.0);
        }
    }

    // ------------------------------------------------------------------ requests

    private boolean driveRequestIsVelocity() {
        if (request instanceof SwerveRequest.FieldCentric r) return r.DriveRequestType == com.ctre.phoenix6.swerve.SwerveModule.DriveRequestType.Velocity;
        if (request instanceof SwerveRequest.RobotCentric r) return r.DriveRequestType == com.ctre.phoenix6.swerve.SwerveModule.DriveRequestType.Velocity;
        if (request instanceof SwerveRequest.ApplyRobotSpeeds r) return r.DriveRequestType == com.ctre.phoenix6.swerve.SwerveModule.DriveRequestType.Velocity;
        return false;
    }

    /** Module states the standing request asks for, or null when it is Idle (or one this layer does not know). */
    private SwerveModuleState[] moduleTargets() {
        if (request instanceof SwerveRequest.FieldCentric r) {
            double vx = r.VelocityX, vy = r.VelocityY, w = r.RotationalRate;
            if (Math.hypot(vx, vy) < r.Deadband) { vx = 0; vy = 0; }
            if (Math.abs(w) < r.RotationalDeadband) w = 0;
            Translation2d v = new Translation2d(vx, vy);
            if (r.ForwardPerspective == SwerveRequest.ForwardPerspectiveValue.OperatorPerspective) v = v.rotateBy(operatorForward);
            ChassisSpeeds speeds = ChassisSpeeds.fromFieldRelativeSpeeds(v.getX(), v.getY(), w, state.Pose.getRotation());
            return toStates(ChassisSpeeds.discretize(speeds, UPDATE_PERIOD), r.DesaturateWheelSpeeds);
        }
        if (request instanceof SwerveRequest.RobotCentric r) {
            double vx = r.VelocityX, vy = r.VelocityY, w = r.RotationalRate;
            if (Math.hypot(vx, vy) < r.Deadband) { vx = 0; vy = 0; }
            if (Math.abs(w) < r.RotationalDeadband) w = 0;
            return toStates(ChassisSpeeds.discretize(new ChassisSpeeds(vx, vy, w), UPDATE_PERIOD), r.DesaturateWheelSpeeds);
        }
        if (request instanceof SwerveRequest.ApplyRobotSpeeds r) {
            return toStates(ChassisSpeeds.discretize(r.Speeds, UPDATE_PERIOD), r.DesaturateWheelSpeeds);
        }
        if (request instanceof SwerveRequest.SwerveDriveBrake) {
            SwerveModuleState[] s = new SwerveModuleState[n];
            for (int i = 0; i < n; i++) s[i] = new SwerveModuleState(0, locations[i].getAngle()); // wheels in an X
            return s;
        }
        return null;
    }

    private SwerveModuleState[] toStates(ChassisSpeeds speeds, boolean desaturate) {
        SwerveModuleState[] s = kinematics.toSwerveModuleStates(speeds);
        if (desaturate) SwerveDriveKinematics.desaturateWheelSpeeds(s, speedAt12[0]);
        return s;
    }

    // ------------------------------------------------------------------ state

    public EmuTalon[] talons() {
        EmuTalon[] all = new EmuTalon[2 * n];
        for (int i = 0; i < n; i++) { all[2 * i] = drive[i]; all[2 * i + 1] = steer[i]; }
        return all;
    }

    private Rotation2d currentAngle(int i) { return Rotation2d.fromRotations(azimuthRot[i]); }

    private Rotation2d rawHeading() { return Rotation2d.fromDegrees(yawDeg); }

    private SwerveModulePosition[] positions() {
        SwerveModulePosition[] p = new SwerveModulePosition[n];
        for (int i = 0; i < n; i++) p[i] = new SwerveModulePosition((driveRotorPos[i] - azimuthRot[i] * coupling[i]) / driveRotationsPerMeter[i], currentAngle(i));
        return p;
    }

    private SwerveModuleState[] states() {
        SwerveModuleState[] s = new SwerveModuleState[n];
        for (int i = 0; i < n; i++) s[i] = new SwerveModuleState((driveRotorVel[i] - azimuthRps[i] * coupling[i]) / driveRotationsPerMeter[i], currentAngle(i));
        return s;
    }

    private void refreshState() {
        SwerveDriveState s = new SwerveDriveState();
        s.Pose = estimator.getEstimatedPosition();
        s.ModuleStates = states();
        s.ModuleTargets = targets;
        s.ModulePositions = positions();
        s.Speeds = kinematics.toChassisSpeeds(s.ModuleStates);
        s.RawHeading = rawHeading();
        s.Timestamp = Timer.getFPGATimestamp();
        s.OdometryPeriod = Double.isNaN(lastEstimatorTime) ? 0 : s.Timestamp - lastEstimatorTime;
        s.SuccessfulDaqs = ++daqs;
        s.FailedDaqs = 0;
        state = s;
    }
}
