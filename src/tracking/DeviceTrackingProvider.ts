/**
 * DeviceTrackingProvider - real device-sensor tracking for the AR camera.
 *
 * Replaces the AlvaAR stub (which faked a static identity pose): orientation is
 * taken from the real `deviceorientationabsolute` / `deviceorientation` sensors
 * (3DoF) and translation is estimated by counting walking steps from
 * `devicemotion` accelerometer peaks, advancing the camera along its horizontal
 * forward axis. Targets iOS Safari first (13+ permission prompts are handled),
 * Android Chrome second.
 *
 * Pure DOM/sensor module: intentionally no `three` import so unit tests run
 * under the global `three` mock in `src/setupTests.ts`. All quaternion math is
 * hand-written, and yaw/forward follow exactly the conventions of
 * `src/rendering/ARWorld.ts`:
 *   yaw = atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x))
 *   forward = (-sin(yaw), 0, -cos(yaw))
 *
 * Never throws: permission requests, sensor callbacks and listener dispatch are
 * all wrapped, and poses are handed out as defensive copies.
 */

import type {
  CameraPose,
  TrackingState,
  TrackingStateListener,
  TrackingProvider,
} from './TrackingProvider';
import type { QuaternionTuple, Vector3Tuple } from '../utils/vec';

/** Permission outcome for the motion/orientation sensors. */
export type DeviceTrackingPermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported';

/**
 * The slice of `Window` this provider actually uses. A real `Window` satisfies
 * it, and tests can inject a fake without casting through `any`.
 */
export interface TrackingWindowLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  readonly screen?: { readonly orientation?: { readonly angle?: number } | null } | null;
  readonly orientation?: number;
  readonly DeviceOrientationEvent?: unknown;
  readonly DeviceMotionEvent?: unknown;
}

export interface DeviceTrackingOptions {
  /** Metres advanced per detected step. */
  stepLengthMeters?: number;
  /** Silence from the orientation sensor beyond this is reported as LOST. */
  lostTimeoutMs?: number;
  /** Acceleration (m/s^2) above the filtered baseline that marks a step peak. */
  stepThreshold?: number;
  /** Debounce between two accepted steps. */
  minStepIntervalMs?: number;
  /** Injectable window (tests); defaults to the global one. */
  window?: TrackingWindowLike | null;
  onPose?: (p: CameraPose) => void;
}

const DEFAULT_STEP_LENGTH_M = 0.7;
const DEFAULT_LOST_TIMEOUT_MS = 1500;
const DEFAULT_STEP_THRESHOLD = 1.6;
const DEFAULT_MIN_STEP_INTERVAL_MS = 280;
const BASELINE_SMOOTHING = 0.1;
const FPS_WINDOW_SAMPLES = 16;
const MIN_LOST_TICK_MS = 100;
const DEG_TO_RAD = Math.PI / 180;

function copyPose(p: CameraPose): CameraPose {
  return {
    position: { x: p.position.x, y: p.position.y, z: p.position.z },
    quaternion: {
      x: p.quaternion.x,
      y: p.quaternion.y,
      z: p.quaternion.z,
      w: p.quaternion.w,
    },
    timestamp: p.timestamp,
    featureCount: p.featureCount,
    trackingFps: p.trackingFps,
  };
}

function normalizeQuat(q: QuaternionTuple): QuaternionTuple {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (!Number.isFinite(len) || len === 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

function quatMultiply(a: QuaternionTuple, b: QuaternionTuple): QuaternionTuple {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Euler (radians) to quaternion in three.js `YXZ` order. */
function quatFromEulerYXZ(x: number, y: number, z: number): QuaternionTuple {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
}

/** Quaternion for a rotation of `angle` radians around +Z. */
function quatFromAxisAngleZ(angle: number): QuaternionTuple {
  return { x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) };
}

function extractYaw(q: QuaternionTuple): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

/**
 * Device orientation angles to a three.js camera quaternion.
 *
 * The standard `DeviceOrientationControls` conversion, hand-written:
 * `YXZ` euler from (beta, alpha, -gamma), then the fixed -90 degree X rotation
 * that maps the screen plane onto a camera looking out of the back of the
 * device, then the current screen-orientation angle around Z.
 */
export function orientationToQuaternion(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg: number
): QuaternionTuple {
  const alpha = (Number.isFinite(alphaDeg) ? alphaDeg : 0) * DEG_TO_RAD;
  const beta = (Number.isFinite(betaDeg) ? betaDeg : 0) * DEG_TO_RAD;
  const gamma = (Number.isFinite(gammaDeg) ? gammaDeg : 0) * DEG_TO_RAD;
  const screen = (Number.isFinite(screenAngleDeg) ? screenAngleDeg : 0) * DEG_TO_RAD;

  const half = Math.sqrt(0.5);
  const q1: QuaternionTuple = { x: -half, y: 0, z: 0, w: half };

  let q = quatFromEulerYXZ(beta, alpha, -gamma);
  q = quatMultiply(q, q1);
  q = quatMultiply(q, quatFromAxisAngleZ(-screen));
  return normalizeQuat(q);
}

function readNumber(source: unknown, key: string): number | null {
  if (typeof source !== 'object' || source === null) {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readProperty(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

/** iOS 13+ exposes `requestPermission()` on the event constructors. */
function getPermissionRequester(ctor: unknown): (() => Promise<unknown>) | null {
  if (ctor === null || ctor === undefined) {
    return null;
  }
  if (typeof ctor !== 'function' && typeof ctor !== 'object') {
    return null;
  }
  const requester = (ctor as { requestPermission?: unknown }).requestPermission;
  if (typeof requester !== 'function') {
    return null;
  }
  const fn = requester as () => unknown;
  return () => Promise.resolve(fn.call(ctor));
}

function resolveDefaultWindow(): TrackingWindowLike | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window;
}

interface BoundListener {
  type: string;
  handler: (event: Event) => void;
}

export class DeviceTrackingProvider implements TrackingProvider {
  private state: TrackingState = 'STOPPED';
  private pose: CameraPose | null = null;
  private listeners = new Set<TrackingStateListener>();
  private bound: BoundListener[] = [];
  private win: TrackingWindowLike | null;
  private opts: DeviceTrackingOptions;

  private readonly stepLengthMeters: number;
  private readonly lostTimeoutMs: number;
  private readonly stepThreshold: number;
  private readonly minStepIntervalMs: number;

  private permission: DeviceTrackingPermissionState = 'unknown';
  private position: Vector3Tuple = { x: 0, y: 0, z: 0 };
  private quaternion: QuaternionTuple = { x: 0, y: 0, z: 0, w: 1 };
  private screenAngleDeg = 0;
  private sawAbsolute = false;
  private lastSampleTime = 0;
  private sampleTimes: number[] = [];
  private fps = 0;

  private stepCount = 0;
  private baseline = 0;
  private hasBaseline = false;
  private peaked = false;
  private lastStepTime = 0;

  private tickHandle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DeviceTrackingOptions = {}) {
    this.opts = opts;
    this.win = opts.window === undefined ? resolveDefaultWindow() : opts.window;
    this.stepLengthMeters =
      typeof opts.stepLengthMeters === 'number' && Number.isFinite(opts.stepLengthMeters)
        ? opts.stepLengthMeters
        : DEFAULT_STEP_LENGTH_M;
    this.lostTimeoutMs =
      typeof opts.lostTimeoutMs === 'number' && opts.lostTimeoutMs > 0
        ? opts.lostTimeoutMs
        : DEFAULT_LOST_TIMEOUT_MS;
    this.stepThreshold =
      typeof opts.stepThreshold === 'number' && Number.isFinite(opts.stepThreshold)
        ? opts.stepThreshold
        : DEFAULT_STEP_THRESHOLD;
    this.minStepIntervalMs =
      typeof opts.minStepIntervalMs === 'number' && opts.minStepIntervalMs >= 0
        ? opts.minStepIntervalMs
        : DEFAULT_MIN_STEP_INTERVAL_MS;
  }

  // --- state -------------------------------------------------------------

  private setState(s: TrackingState): void {
    if (this.state === s) {
      return;
    }
    this.state = s;
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch {
        // ignore listener errors: provider must never throw
      }
    }
  }

  /**
   * Authoritative LOST check. Lazy so tests (and callers) never depend on the
   * interval timer having fired.
   */
  private refreshLost(): void {
    if (this.state !== 'ACTIVE' || this.lastSampleTime === 0) {
      return;
    }
    if (Date.now() - this.lastSampleTime > this.lostTimeoutMs) {
      this.setState('LOST');
    }
  }

  // --- sensor plumbing ---------------------------------------------------

  private addListener(type: string, handler: (event: Event) => void): void {
    const target = this.win;
    if (target === null) {
      return;
    }
    try {
      target.addEventListener(type, handler);
      this.bound.push({ type, handler });
    } catch {
      // ignore: a hostile/partial window must not break tracking
    }
  }

  private removeAllListeners(): void {
    const target = this.win;
    for (const entry of this.bound) {
      if (target === null) {
        continue;
      }
      try {
        target.removeEventListener(entry.type, entry.handler);
      } catch {
        // ignore
      }
    }
    this.bound = [];
  }

  private readScreenAngle(): number {
    const target = this.win;
    if (target === null) {
      return 0;
    }
    const fromScreen = readNumber(readProperty(target.screen, 'orientation'), 'angle');
    if (fromScreen !== null) {
      return fromScreen;
    }
    const legacy = readNumber(target, 'orientation');
    return legacy === null ? 0 : legacy;
  }

  private handleScreenOrientationChange = (): void => {
    try {
      this.screenAngleDeg = this.readScreenAngle();
    } catch {
      // ignore
    }
  };

  private handleOrientation = (event: Event, absolute: boolean): void => {
    try {
      if (this.state === 'STOPPED') {
        return;
      }
      if (!absolute && this.sawAbsolute) {
        // prefer absolute samples once the device has proven it emits usable ones
        return;
      }
      const alpha = readNumber(event, 'alpha');
      const beta = readNumber(event, 'beta');
      const gamma = readNumber(event, 'gamma');
      if (alpha === null && beta === null && gamma === null) {
        return;
      }
      if (absolute) {
        // Latch only on a USABLE absolute sample: Chromium fires exactly one
        // all-null `deviceorientationabsolute` on subscribe, and latching on
        // that would discard every relative sample forever - tracking would
        // never reach ACTIVE.
        this.sawAbsolute = true;
      }
      const now = Date.now();
      this.quaternion = orientationToQuaternion(
        alpha ?? 0,
        beta ?? 0,
        gamma ?? 0,
        this.screenAngleDeg
      );
      this.lastSampleTime = now;
      this.updateFps(now);
      this.pose = {
        position: { x: this.position.x, y: this.position.y, z: this.position.z },
        quaternion: { ...this.quaternion },
        timestamp: now,
        featureCount: 0,
        trackingFps: this.fps,
      };
      if (this.state !== 'ACTIVE') {
        this.setState('ACTIVE');
      }
      this.emitPose();
    } catch {
      // never throw out of a sensor callback
    }
  };

  private handleAbsoluteOrientation = (event: Event): void => {
    this.handleOrientation(event, true);
  };

  private handleRelativeOrientation = (event: Event): void => {
    this.handleOrientation(event, false);
  };

  private handleMotion = (event: Event): void => {
    try {
      if (this.state === 'STOPPED') {
        return;
      }
      let acc = readProperty(event, 'accelerationIncludingGravity');
      let x = readNumber(acc, 'x');
      let y = readNumber(acc, 'y');
      let z = readNumber(acc, 'z');
      if (x === null && y === null && z === null) {
        acc = readProperty(event, 'acceleration');
        x = readNumber(acc, 'x');
        y = readNumber(acc, 'y');
        z = readNumber(acc, 'z');
      }
      if (x === null && y === null && z === null) {
        return;
      }
      const ax = x ?? 0;
      const ay = y ?? 0;
      const az = z ?? 0;
      const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
      if (!Number.isFinite(magnitude)) {
        return;
      }
      if (!this.hasBaseline) {
        this.baseline = magnitude;
        this.hasBaseline = true;
        return;
      }
      const now = Date.now();
      if (!this.peaked && magnitude > this.baseline + this.stepThreshold) {
        this.peaked = true;
      } else if (this.peaked && magnitude < this.baseline) {
        this.peaked = false;
        if (now - this.lastStepTime >= this.minStepIntervalMs) {
          this.lastStepTime = now;
          this.registerStep();
        }
      }
      this.baseline += (magnitude - this.baseline) * BASELINE_SMOOTHING;
    } catch {
      // never throw out of a sensor callback
    }
  };

  private registerStep(): void {
    const yaw = extractYaw(this.quaternion);
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    this.position = {
      x: this.position.x + forwardX * this.stepLengthMeters,
      y: this.position.y,
      z: this.position.z + forwardZ * this.stepLengthMeters,
    };
    this.stepCount += 1;
    if (this.pose !== null) {
      this.pose.position = { x: this.position.x, y: this.position.y, z: this.position.z };
    }
  }

  private updateFps(now: number): void {
    this.sampleTimes.push(now);
    if (this.sampleTimes.length > FPS_WINDOW_SAMPLES) {
      this.sampleTimes.shift();
    }
    const count = this.sampleTimes.length;
    if (count < 2) {
      this.fps = 0;
      return;
    }
    const span = this.sampleTimes[count - 1] - this.sampleTimes[0];
    this.fps = span > 0 ? Math.round(((count - 1) * 1000) / span) : 0;
  }

  private emitPose(): void {
    const current = this.pose;
    if (current === null || this.opts.onPose === undefined) {
      return;
    }
    try {
      this.opts.onPose(copyPose(current));
    } catch {
      // ignore listener errors: provider must never throw
    }
  }

  private startTicker(): void {
    if (this.tickHandle !== null) {
      return;
    }
    try {
      const period = Math.max(MIN_LOST_TICK_MS, Math.floor(this.lostTimeoutMs / 3));
      this.tickHandle = setInterval(() => {
        this.refreshLost();
      }, period);
      // never keep a node/jest process alive for a background health check
      const handle: unknown = this.tickHandle;
      if (typeof handle === 'object' && handle !== null) {
        const unref = (handle as { unref?: unknown }).unref;
        if (typeof unref === 'function') {
          (unref as () => void).call(handle);
        }
      }
    } catch {
      this.tickHandle = null;
    }
  }

  private stopTicker(): void {
    if (this.tickHandle === null) {
      return;
    }
    try {
      clearInterval(this.tickHandle);
    } catch {
      // ignore
    }
    this.tickHandle = null;
  }

  // --- public API --------------------------------------------------------

  async start(): Promise<void> {
    try {
      if (this.state !== 'STOPPED') {
        return;
      }
      this.setState('INITIALIZING');

      const target = this.win;
      if (target === null || !this.isSupported()) {
        this.permission = 'unsupported';
        this.setState('LOST');
        return;
      }

      const orientationRequester = getPermissionRequester(target.DeviceOrientationEvent);
      if (orientationRequester !== null) {
        let granted = false;
        try {
          const result = await orientationRequester();
          granted = result === 'granted';
        } catch {
          granted = false;
        }
        if (this.getState() !== 'INITIALIZING') {
          return;
        }
        if (!granted) {
          this.permission = 'denied';
          this.setState('LOST');
          return;
        }
      }

      // A denied motion permission is not fatal: orientation-only tracking
      // still works, it simply cannot translate the camera.
      let motionAllowed = true;
      const motionRequester = getPermissionRequester(target.DeviceMotionEvent);
      if (motionRequester !== null) {
        try {
          const result = await motionRequester();
          motionAllowed = result === 'granted';
        } catch {
          motionAllowed = false;
        }
        if (this.getState() !== 'INITIALIZING') {
          return;
        }
      }

      this.screenAngleDeg = this.readScreenAngle();

      if (readProperty(target, 'ondeviceorientationabsolute') !== undefined) {
        this.addListener('deviceorientationabsolute', this.handleAbsoluteOrientation);
      }
      this.addListener('deviceorientation', this.handleRelativeOrientation);
      if (motionAllowed) {
        this.addListener('devicemotion', this.handleMotion);
      }
      this.addListener('orientationchange', this.handleScreenOrientationChange);

      this.permission = 'granted';
      this.startTicker();
    } catch {
      // never throw from start()
      try {
        if (this.getState() === 'INITIALIZING') {
          this.setState('LOST');
        }
      } catch {
        // ignore
      }
    }
  }

  stop(): void {
    try {
      this.removeAllListeners();
      this.stopTicker();
      this.pose = null;
      this.fps = 0;
      this.sampleTimes = [];
      this.lastSampleTime = 0;
      this.sawAbsolute = false;
      this.position = { x: 0, y: 0, z: 0 };
      this.quaternion = { x: 0, y: 0, z: 0, w: 1 };
      this.stepCount = 0;
      this.baseline = 0;
      this.hasBaseline = false;
      this.peaked = false;
      this.lastStepTime = 0;
      this.setState('STOPPED');
    } catch {
      // never throw from stop()
    }
  }

  getPose(): CameraPose | null {
    this.refreshLost();
    if (this.state !== 'ACTIVE' || this.pose === null) {
      return null;
    }
    return copyPose(this.pose);
  }

  getState(): TrackingState {
    this.refreshLost();
    return this.state;
  }

  onStateChange(cb: TrackingStateListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Measured orientation-sample rate, rounded; 0 before enough samples. */
  getFps(): number {
    return this.fps;
  }

  getStepCount(): number {
    return this.stepCount;
  }

  isSupported(): boolean {
    const target = this.win;
    if (target === null) {
      return false;
    }
    const ctor = target.DeviceOrientationEvent;
    return ctor !== undefined && ctor !== null;
  }

  getPermissionState(): DeviceTrackingPermissionState {
    return this.permission;
  }
}
