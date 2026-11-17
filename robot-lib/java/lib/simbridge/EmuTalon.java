package frc.robot.lib.simbridge;

import com.ctre.phoenix6.configs.TalonFXConfiguration;
import com.ctre.phoenix6.signals.NeutralModeValue;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.system.plant.DCMotor;
import edu.wpi.first.math.util.Units;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;

/**
 * A Java emulation of a TalonFX's control loop for lockstep (Mode B). The Phoenix sim runs the real firmware loop on a native thread
 * against the wall clock, which cannot follow a stepped clock (spike S5); this runs the same controllers in simulated time, one step per
 * lockstep exchange, so a run is repeatable and can go faster than real time.
 *
 * What it does, in the units of the mechanism (rotor rotations divided by the config's SensorToMechanismRatio):
 * VoltageOut (with the open-loop voltage ramp), MotionMagic position and velocity profiles (trapezoid, or an acceleration ramp when jerk
 * is set), PositionVoltage and VelocityVoltage, the Slot0 feedforward and PID (kS by the sign of the reference velocity or the error, kV, kA,
 * kP, kI, kD), the stator current limit (as a window on the voltage, from the motor's resistance and back-EMF) and the supply voltage.
 * The rotor position and velocity come from the app's physics (applyRotor); the voltage it computes goes back to the app in the next ToApp frame.
 *
 * Not modeled: Phoenix Pro features, soft limits, supply current limits, differential control, brake versus coast (an output of 0 V is
 * the shorted winding in both, as in the Phoenix sim).
 */
public final class EmuTalon {
    private enum Mode { NEUTRAL, VOLTAGE, MM_POSITION, MM_VELOCITY, POSITION, VELOCITY }

    private final int id;
    private final double ratio; // rotor rotations per mechanism rotation
    private final double kS, kV, kA, kP, kI, kD;
    private final double cruise, accel, jerk; // mechanism units per second
    private final boolean limitEnabled;
    private final double statorLimit;
    private final double resistance; // ohms of one motor
    private final double keRotor; // V per rotor rad/s
    private final double rampVoltsPerSecond; // 0 = none
    private final int motorCount;
    private final double inertia;
    private final String motorName;

    private Mode mode = Mode.NEUTRAL;
    private double target;
    private double requestedVolts;
    private double rampedVolts;
    private double refPos, refVel, refAcc;
    private double integral;
    private boolean profileValid;
    private boolean continuousWrap;

    // from the app
    private double rotorPos, rotorVel, rotorAcc;
    // outputs
    private double appliedVolts;
    private double current;
    private double closedLoopError;
    private double closedLoopReference;

    /**
     * @param motor one motor of the model (the stator current limit applies per motor); count is how many share this load
     */
    public EmuTalon(int id, TalonFXConfiguration cfg, DCMotor motor, int count, double inertiaKgM2, String motorName) {
        this.id = id;
        this.motorCount = count;
        this.inertia = inertiaKgM2;
        this.motorName = motorName;
        double r = cfg.Feedback.SensorToMechanismRatio;
        this.ratio = r == 0 ? 1.0 : r;
        kS = cfg.Slot0.kS; kV = cfg.Slot0.kV; kA = cfg.Slot0.kA; kP = cfg.Slot0.kP; kI = cfg.Slot0.kI; kD = cfg.Slot0.kD;
        // an unset (0) or infinite profile limit reads back from a real device as 0, and the Talon sim (TalonFXSim) then substitutes limits from
        // the motor's free speed so the mechanism still moves; do the same so both modes agree
        double freeSpeedMech = Units.radiansToRotations(motor.freeSpeedRadPerSec) / ratio;
        double c = cfg.MotionMagic.MotionMagicCruiseVelocity;
        double a = cfg.MotionMagic.MotionMagicAcceleration;
        cruise = (c > 0 && Double.isFinite(c)) ? c : freeSpeedMech * 0.75;
        accel = (a > 0 && Double.isFinite(a)) ? a : freeSpeedMech * 3.0;
        jerk = Double.isFinite(cfg.MotionMagic.MotionMagicJerk) ? Math.max(0, cfg.MotionMagic.MotionMagicJerk) : 0;
        limitEnabled = cfg.CurrentLimits.StatorCurrentLimitEnable;
        statorLimit = cfg.CurrentLimits.StatorCurrentLimit;
        resistance = motor.rOhms;
        keRotor = 1.0 / motor.KvRadPerSecPerVolt;
        double ramp = cfg.OpenLoopRamps.VoltageOpenLoopRampPeriod;
        rampVoltsPerSecond = ramp > 0 ? 12.0 / ramp : 0;
        if (cfg.MotorOutput.NeutralMode == NeutralModeValue.Brake) { /* 0 V is the shorted winding either way */ }
    }

    public int id() { return id; }

    /** Position control takes the shortest way around (a swerve steer motor). */
    public synchronized void setContinuousWrap(boolean wrap) { continuousWrap = wrap; }

    public int motorCount() { return motorCount; }

    public double ratio() { return ratio; }

    public double inertia() { return inertia; }

    public String motorName() { return motorName; }

    // ------------------------------------------------------------------ controls (robot thread)

    public synchronized void setVoltage(double volts) {
        if (mode != Mode.VOLTAGE) { mode = Mode.VOLTAGE; rampedVolts = appliedVolts; profileValid = false; integral = 0; }
        requestedVolts = volts;
    }

    public synchronized void setMotionMagicPosition(double mechanismRot) { closedLoop(Mode.MM_POSITION, mechanismRot); }

    public synchronized void setMotionMagicVelocity(double mechanismRps) { closedLoop(Mode.MM_VELOCITY, mechanismRps); }

    public synchronized void setPosition(double mechanismRot) { closedLoop(Mode.POSITION, mechanismRot); }

    public synchronized void setVelocity(double mechanismRps) { closedLoop(Mode.VELOCITY, mechanismRps); }

    /** The code zeroed the sensor: the app zeroes its physics state for this device too (as in the Phoenix-sim path). */
    public synchronized void resetPosition() {
        SimBridge.requestReset(id);
        rotorPos = 0; rotorVel = 0; profileValid = false;
    }

    public synchronized void stop() {
        mode = Mode.NEUTRAL;
        profileValid = false;
        integral = 0;
    }

    private void closedLoop(Mode m, double t) {
        if (mode != m) { mode = m; profileValid = false; integral = 0; }
        target = t;
    }

    // ------------------------------------------------------------------ feedback (robot thread)

    public synchronized double position() { return rotorPos / ratio; }

    public synchronized double velocity() { return rotorVel / ratio; }

    public synchronized double appliedVolts() { return appliedVolts; }

    public synchronized double statorCurrent() { return current; }

    public synchronized double closedLoopError() { return closedLoopError; }

    public synchronized double closedLoopReference() { return closedLoopReference; }

    // ------------------------------------------------------------------ the exchange (lockstep thread)

    /** The rotor state the app's physics ended the last step with. */
    public synchronized void applyRotor(double positionRot, double velocityRps, double accelRps2) {
        rotorPos = positionRot; rotorVel = velocityRps; rotorAcc = accelRps2;
    }

    /** One control step of dt seconds: the voltage to apply over the next step. */
    public synchronized double update(double dt) {
        double pos = rotorPos / ratio;
        double vel = rotorVel / ratio;
        double acc = rotorAcc / ratio;
        double supply = RobotController.getBatteryVoltage();
        double volts = 0;
        if (!DriverStationSim.getEnabled()) {
            // a disabled robot drives nothing: the Talon outputs neutral (0 V here) and starts its controller afresh when it is enabled again
            profileValid = false; integral = 0; rampedVolts = 0;
            appliedVolts = 0; current = (0 - keRotor * rotorVel * 2 * Math.PI) / resistance;
            closedLoopError = 0;
            return 0;
        }
        switch (mode) {
            case NEUTRAL -> { volts = 0; closedLoopError = 0; closedLoopReference = 0; }
            case VOLTAGE -> {
                if (rampVoltsPerSecond > 0) rampedVolts += MathUtil.clamp(requestedVolts - rampedVolts, -rampVoltsPerSecond * dt, rampVoltsPerSecond * dt);
                else rampedVolts = requestedVolts;
                volts = rampedVolts;
                closedLoopError = 0;
            }
            case MM_POSITION -> {
                startProfile(pos, vel);
                stepPositionProfile(dt);
                double err = refPos - pos;
                volts = feedforward(refVel, err) + kV * refVel + kA * refAcc + pid(err, refVel - vel, dt);
                closedLoopError = err; closedLoopReference = refPos;
            }
            case MM_VELOCITY -> {
                startProfile(pos, vel);
                stepVelocityProfile(dt);
                double err = refVel - vel;
                volts = kS * Math.signum(refVel) + kV * refVel + kA * refAcc + pid(err, refAcc - acc, dt);
                closedLoopError = err; closedLoopReference = refVel;
            }
            case POSITION -> {
                double err = target - pos;
                if (continuousWrap) err -= Math.rint(err);
                volts = feedforward(0, err) + pid(err, -vel, dt);
                closedLoopError = err; closedLoopReference = target;
            }
            case VELOCITY -> {
                double err = target - vel;
                volts = kS * Math.signum(target) + kV * target + pid(err, -acc, dt);
                closedLoopError = err; closedLoopReference = target;
            }
        }
        volts = MathUtil.clamp(volts, -supply, supply);
        if (limitEnabled && statorLimit > 0 && mode != Mode.NEUTRAL) {
            // current = (V - back-EMF) / R: keep it inside the stator limit
            double emf = keRotor * rotorVel * 2 * Math.PI;
            volts = MathUtil.clamp(volts, emf - statorLimit * resistance, emf + statorLimit * resistance);
        }
        appliedVolts = volts;
        current = (volts - keRotor * rotorVel * 2 * Math.PI) / resistance;
        return volts;
    }

    private double feedforward(double refVelocity, double error) {
        double s = refVelocity != 0 ? Math.signum(refVelocity) : (Math.abs(error) > 1e-5 ? Math.signum(error) : 0);
        return kS * s;
    }

    private double pid(double error, double dError, double dt) {
        if (kI != 0) integral += error * dt;
        return kP * error + kI * integral + kD * dError;
    }

    private void startProfile(double pos, double vel) {
        if (profileValid) return;
        profileValid = true;
        refPos = pos; refVel = vel; refAcc = 0;
    }

    private double nextVelocity(double desired, double dt) {
        double dv = desired - refVel;
        double desiredAcc = MathUtil.clamp(dv / dt, -accel, accel);
        double newAcc = jerk > 0 ? refAcc + MathUtil.clamp(desiredAcc - refAcc, -jerk * dt, jerk * dt) : desiredAcc;
        refAcc = newAcc;
        return refVel + newAcc * dt;
    }

    private void stepPositionProfile(double dt) {
        double dist = target - refPos;
        // fastest speed from which the profile can still stop at the target with the allowed deceleration
        double vStop = Math.sqrt(2 * accel * Math.abs(dist));
        double desired = Math.signum(dist) * Math.min(cruise, vStop);
        double newVel = nextVelocity(desired, dt);
        refPos += 0.5 * (refVel + newVel) * dt;
        refVel = newVel;
        if (Math.abs(target - refPos) <= 0.5 * accel * dt * dt && Math.abs(refVel) <= accel * dt) { refPos = target; refVel = 0; refAcc = 0; }
    }

    private void stepVelocityProfile(double dt) {
        double newVel = nextVelocity(target, dt); // a velocity profile is limited by acceleration (and jerk) only
        refPos += 0.5 * (refVel + newVel) * dt;
        refVel = newVel;
    }
}
