package frc.robot.lib;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import com.ctre.phoenix6.configs.MotionMagicConfigs;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.sim.ChassisReference;
import com.ctre.phoenix6.sim.TalonFXSimState;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.system.plant.DCMotor;
import edu.wpi.first.math.system.plant.LinearSystemId;
import edu.wpi.first.math.util.Units;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.Notifier;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.simulation.DCMotorSim;
import frc.robot.lib.simbridge.SimBridge;

/**
 * Physics behind a simulated TalonFX. The TalonFX sim runs the real control loop (MotionMagic,
 * VoltageOut, ...) and this feeds it a rotor position and velocity from a DCMotorSim, so the
 * mechanism actually moves with the same gains and gear ratio as on the robot.
 *
 * The physics runs on its own fast thread (like the swerve sim) using real elapsed time. Stepping it from the
 * robot loop instead gives the Talon's 1 kHz control loop stale, time-distorted feedback whenever the main loop
 * runs long, and high-gain loops (hood, intake) then oscillate in a limit cycle.
 */
public class TalonFXSim {
    private final TalonFXSimState simState;
    private final DCMotorSim physics;
    private static final double STEP_PERIOD_SECONDS = 0.005;
    private static final List<TalonFXSim> instances = new CopyOnWriteArrayList<>();
    private static Notifier notifier;

    private final int deviceId;
    private final double sensorToMechanism;
    private double lastTimeSeconds = Timer.getFPGATimestamp();

    /**
     * @param motor             the TalonFX to drive (its simulated device)
     * @param motors            motor model, including how many motors share this load
     * @param sensorToMechanism rotor rotations per mechanism rotation (the config's SensorToMechanismRatio)
     * @param inertiaKgM2       moment of inertia of the mechanism, about its own axis
     * @param inverted          true if the motor is configured Clockwise_Positive
     */
    public TalonFXSim(TalonFX motor, DCMotor motors, double sensorToMechanism, double inertiaKgM2, boolean inverted) {
        // A MotionMagic profile with cruise velocity or acceleration of 0 never moves in the sim (infinity in
        // the robot code reads back from the device as 0 too). Substitute a profile based on the motor's
        // free speed so the mechanism still moves, and say so, since the robot config may need real limits.
        var profile = new MotionMagicConfigs();
        motor.getConfigurator().refresh(profile);
        if (profile.MotionMagicCruiseVelocity <= 0 || profile.MotionMagicAcceleration <= 0) {
            double freeSpeedMechRps = Units.radiansToRotations(motors.freeSpeedRadPerSec) / sensorToMechanism;
            if (profile.MotionMagicCruiseVelocity <= 0) profile.MotionMagicCruiseVelocity = freeSpeedMechRps * 0.75;
            if (profile.MotionMagicAcceleration <= 0) profile.MotionMagicAcceleration = freeSpeedMechRps * 3.0;
            motor.getConfigurator().apply(profile);
            DriverStation.reportWarning("TalonFX " + motor.getDeviceID()
                    + ": MotionMagic cruise velocity/acceleration is 0 in the config; the sim uses a profile based on the motor's free speed", false);
        }

        this.simState = motor.getSimState();
        // Tell the device which motor it is, so its current/back-EMF model matches the DCMotorSim below.
        // (Left at the default X60 while simulating an X44, the Talon sees a permanent overspeed and its current
        // limiter stops the mechanism from ever braking.)
        boolean isX44 = Math.abs(motors.freeSpeedRadPerSec - DCMotor.getKrakenX44(1).freeSpeedRadPerSec) < 1.0;
        simState.setMotorType(isX44 ? TalonFXSimState.MotorType.KrakenX44 : TalonFXSimState.MotorType.KrakenX60);
        this.sensorToMechanism = sensorToMechanism;
        this.physics = new DCMotorSim(
                LinearSystemId.createDCMotorSystem(motors, inertiaKgM2, sensorToMechanism), motors);
        simState.Orientation = inverted
                ? ChassisReference.Clockwise_Positive
                : ChassisReference.CounterClockwise_Positive;

        this.deviceId = motor.getDeviceID();
        if (SimBridge.isEnabled()) {
            // the Crucible app owns the physics: it gets this motor's voltage and returns rotor position and velocity
            int count = (int) Math.max(1, Math.round(motors.stallTorqueNewtonMeters
                    / (isX44 ? DCMotor.getKrakenX44(1) : DCMotor.getKrakenX60(1)).stallTorqueNewtonMeters));
            SimBridge.registerMechanism(deviceId, simState, isX44 ? "krakenX44" : "krakenX60", count, sensorToMechanism, inertiaKgM2);
            return;
        }

        // one sim per device: a newer one replaces any earlier one on the same CAN ID
        instances.removeIf(s -> s.deviceId == deviceId);
        instances.add(this);
        startNotifier();
    }

    private static synchronized void startNotifier() {
        if (notifier != null) return;
        notifier = new Notifier(() -> {
            for (TalonFXSim sim : instances) sim.step();
        });
        notifier.startPeriodic(STEP_PERIOD_SECONDS);
    }

    private synchronized void step() {
        double now = Timer.getFPGATimestamp();
        double dt = MathUtil.clamp(now - lastTimeSeconds, 0.0, 0.05);
        lastTimeSeconds = now;
        if (dt <= 0.0) return;
        simState.setSupplyVoltage(RobotController.getBatteryVoltage());
        physics.setInputVoltage(simState.getMotorVoltage());
        physics.update(dt);
        simState.setRawRotorPosition(physics.getAngularPositionRotations() * sensorToMechanism);
        simState.setRotorVelocity(Units.radiansToRotations(physics.getAngularVelocityRadPerSec()) * sensorToMechanism);
    }

    /** Keep the physics in step when the code re-zeroes the motor's position. */
    public synchronized void resetPosition() {
        if (SimBridge.isEnabled()) { SimBridge.requestReset(deviceId); return; }
        physics.setState(0.0, 0.0);
    }
}
