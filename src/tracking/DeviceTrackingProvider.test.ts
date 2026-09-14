import {
  DeviceTrackingProvider,
  orientationToQuaternion,
  type TrackingWindowLike,
} from './DeviceTrackingProvider';

interface Registration {
  type: string;
  handler: (event: Event) => void;
}

/**
 * Minimal recording window stand-in: no real sensors are ever touched, tests
 * drive the provider by dispatching synthetic events.
 */
class FakeWindow implements TrackingWindowLike {
  added: Registration[] = [];
  removed: Registration[] = [];
  screen: { orientation: { angle: number } } = { orientation: { angle: 0 } };
  DeviceOrientationEvent: unknown = function DeviceOrientationEventCtor(): void {};
  DeviceMotionEvent: unknown = function DeviceMotionEventCtor(): void {};
  ondeviceorientationabsolute: unknown = null;

  addEventListener(type: string, handler: (event: Event) => void): void {
    this.added.push({ type, handler });
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    this.removed.push({ type, handler });
  }

  types(): string[] {
    return this.added.map((r) => r.type);
  }

  dispatch(type: string, payload: unknown): void {
    for (const reg of this.added) {
      if (reg.type === type) {
        reg.handler(payload as Event);
      }
    }
  }
}

function orientationEvent(alpha: number, beta: number, gamma: number): unknown {
  return { alpha, beta, gamma };
}

function motionEvent(magnitude: number): unknown {
  return { accelerationIncludingGravity: { x: 0, y: 0, z: magnitude } };
}

function quatLength(q: { x: number; y: number; z: number; w: number }): number {
  return Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
}

/** Feed one full accelerometer peak-then-valley (a "step") into the provider. */
function walkOneStep(win: FakeWindow): void {
  win.dispatch('devicemotion', motionEvent(9.8 + 5));
  win.dispatch('devicemotion', motionEvent(9.8 - 5));
}

describe('DeviceTrackingProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initializes STOPPED with null pose, zero fps/steps and unknown permission', () => {
    const p = new DeviceTrackingProvider({ window: new FakeWindow() });
    expect(p.getState()).toBe('STOPPED');
    expect(p.getPose()).toBeNull();
    expect(p.getFps()).toBe(0);
    expect(p.getStepCount()).toBe(0);
    expect(p.getPermissionState()).toBe('unknown');
    expect(p.isSupported()).toBe(true);
  });

  it('reports unsupported windows as LOST without throwing', async () => {
    const win = new FakeWindow();
    win.DeviceOrientationEvent = undefined;
    const p = new DeviceTrackingProvider({ window: win });
    expect(p.isSupported()).toBe(false);
    await expect(p.start()).resolves.toBeUndefined();
    expect(p.getState()).toBe('LOST');
    expect(p.getPermissionState()).toBe('unsupported');
    expect(win.added).toHaveLength(0);
  });

  it('handles a null window without throwing', async () => {
    const p = new DeviceTrackingProvider({ window: null });
    await expect(p.start()).resolves.toBeUndefined();
    expect(p.getState()).toBe('LOST');
    expect(p.getPermissionState()).toBe('unsupported');
  });

  it('registers all sensor listeners on the iOS granted path', async () => {
    const win = new FakeWindow();
    const requestPermission = jest.fn().mockResolvedValue('granted');
    win.DeviceOrientationEvent = { requestPermission };
    win.DeviceMotionEvent = { requestPermission };
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(p.getPermissionState()).toBe('granted');
    expect(win.types()).toEqual([
      'deviceorientationabsolute',
      'deviceorientation',
      'devicemotion',
      'orientationchange',
    ]);
    p.stop();
  });

  it('goes LOST with denied permission when iOS refuses orientation', async () => {
    const win = new FakeWindow();
    win.DeviceOrientationEvent = { requestPermission: jest.fn().mockResolvedValue('denied') };
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    expect(p.getState()).toBe('LOST');
    expect(p.getPermissionState()).toBe('denied');
    expect(win.added).toHaveLength(0);
  });

  it('goes LOST with denied permission when the permission request throws', async () => {
    const win = new FakeWindow();
    win.DeviceOrientationEvent = {
      requestPermission: jest.fn().mockRejectedValue(new Error('nope')),
    };
    const p = new DeviceTrackingProvider({ window: win });
    await expect(p.start()).resolves.toBeUndefined();
    expect(p.getState()).toBe('LOST');
    expect(p.getPermissionState()).toBe('denied');
  });

  it('keeps orientation tracking when only motion permission is denied', async () => {
    const win = new FakeWindow();
    win.DeviceOrientationEvent = { requestPermission: jest.fn().mockResolvedValue('granted') };
    win.DeviceMotionEvent = { requestPermission: jest.fn().mockResolvedValue('denied') };
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    expect(p.getPermissionState()).toBe('granted');
    expect(win.types()).not.toContain('devicemotion');
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    expect(p.getState()).toBe('ACTIVE');
    walkOneStep(win);
    expect(p.getStepCount()).toBe(0);
    p.stop();
  });

  it('becomes ACTIVE with a unit-quaternion pose on the first orientation sample', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    expect(p.getState()).toBe('INITIALIZING');
    expect(p.getPose()).toBeNull();

    win.dispatch('deviceorientationabsolute', orientationEvent(0, 90, 0));
    expect(p.getState()).toBe('ACTIVE');
    const pose = p.getPose();
    expect(pose).not.toBeNull();
    expect(pose?.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(quatLength(pose!.quaternion)).toBeCloseTo(1, 10);
    expect(pose?.featureCount).toBe(0);
    p.stop();
  });

  it('ignores relative samples once an absolute sample has been seen', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    win.dispatch('deviceorientationabsolute', orientationEvent(0, 90, 0));
    const absolutePose = p.getPose();
    win.dispatch('deviceorientation', orientationEvent(90, 90, 0));
    expect(p.getPose()?.quaternion).toEqual(absolutePose?.quaternion);
    p.stop();
  });

  it('does not latch on an all-null absolute sample (Chromium fires one on subscribe)', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();

    // Chromium emits exactly one absolute event with null angles as soon as
    // the page subscribes. Latching on it used to discard every later
    // relative sample, so tracking could never reach ACTIVE.
    win.dispatch('deviceorientationabsolute', { alpha: null, beta: null, gamma: null });
    expect(p.getState()).toBe('INITIALIZING');
    expect(p.getPose()).toBeNull();

    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    expect(p.getState()).toBe('ACTIVE');
    expect(p.getPose()).not.toBeNull();
    p.stop();
  });

  it('ignores orientation samples with no usable angles', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    win.dispatch('deviceorientation', { alpha: null, beta: null, gamma: undefined });
    expect(p.getState()).toBe('INITIALIZING');
    expect(p.getPose()).toBeNull();
    p.stop();
  });

  it('measures an fps once several samples have arrived', async () => {
    const win = new FakeWindow();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    expect(p.getFps()).toBe(0);
    now.mockReturnValue(1_020);
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    now.mockReturnValue(1_040);
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    expect(p.getFps()).toBe(50);
    expect(p.getPose()?.trackingFps).toBe(50);
    p.stop();
  });

  describe('orientationToQuaternion', () => {
    it('returns a unit quaternion for arbitrary angles', () => {
      const q = orientationToQuaternion(37, -14, 122, 90);
      expect(quatLength(q)).toBeCloseTo(1, 10);
    });

    it('maps an upright device (beta=90) to the identity camera rotation', () => {
      const q = orientationToQuaternion(0, 90, 0, 0);
      expect(q.x).toBeCloseTo(0, 10);
      expect(q.y).toBeCloseTo(0, 10);
      expect(q.z).toBeCloseTo(0, 10);
      expect(Math.abs(q.w)).toBeCloseTo(1, 10);
    });

    it('maps alpha=90 on an upright device to a quarter turn about +Y', () => {
      const q = orientationToQuaternion(90, 90, 0, 0);
      expect(q.x).toBeCloseTo(0, 10);
      expect(q.y).toBeCloseTo(Math.SQRT1_2, 10);
      expect(q.z).toBeCloseTo(0, 10);
      expect(q.w).toBeCloseTo(Math.SQRT1_2, 10);
    });

    it('is deterministic and tolerates non-finite input', () => {
      const a = orientationToQuaternion(12, 34, 56, 270);
      const b = orientationToQuaternion(12, 34, 56, 270);
      expect(a).toEqual(b);
      expect(quatLength(orientationToQuaternion(NaN, 34, 56, NaN))).toBeCloseTo(1, 10);
    });
  });

  it('reports LOST when no orientation sample arrives within lostTimeoutMs', async () => {
    const win = new FakeWindow();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(10_000);
    const p = new DeviceTrackingProvider({ window: win, lostTimeoutMs: 500 });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    expect(p.getState()).toBe('ACTIVE');

    now.mockReturnValue(10_600);
    expect(p.getState()).toBe('LOST');
    expect(p.getPose()).toBeNull();

    now.mockReturnValue(10_700);
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    expect(p.getState()).toBe('ACTIVE');
    expect(p.getPose()).not.toBeNull();
    p.stop();
  });

  it('advances the position one step length along forward on a detected step', async () => {
    const win = new FakeWindow();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(5_000);
    const p = new DeviceTrackingProvider({ window: win, stepLengthMeters: 0.7 });
    await p.start();
    // upright device facing the default forward direction (-Z)
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    win.dispatch('devicemotion', motionEvent(9.8)); // seeds the baseline

    walkOneStep(win);
    expect(p.getStepCount()).toBe(1);
    const afterOne = p.getPose();
    expect(afterOne?.position.x).toBeCloseTo(0, 6);
    expect(afterOne?.position.y).toBeCloseTo(0, 6);
    expect(afterOne?.position.z).toBeCloseTo(-0.7, 6);

    // too soon: debounced away
    now.mockReturnValue(5_100);
    walkOneStep(win);
    expect(p.getStepCount()).toBe(1);
    expect(p.getPose()?.position.z).toBeCloseTo(-0.7, 6);

    // after minStepIntervalMs a second step counts
    now.mockReturnValue(5_400);
    walkOneStep(win);
    expect(p.getStepCount()).toBe(2);
    expect(p.getPose()?.position.z).toBeCloseTo(-1.4, 6);
    p.stop();
  });

  it('steps along the yawed forward direction after turning', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win, stepLengthMeters: 1 });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(90, 90, 0));
    win.dispatch('devicemotion', motionEvent(9.8));
    walkOneStep(win);
    const pose = p.getPose();
    expect(pose?.position.x).toBeCloseTo(-1, 6);
    expect(pose?.position.z).toBeCloseTo(0, 6);
    p.stop();
  });

  it('ignores motion events without usable acceleration data', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    win.dispatch('devicemotion', {});
    win.dispatch('devicemotion', { accelerationIncludingGravity: null });
    win.dispatch('devicemotion', { acceleration: { x: 0, y: 0, z: 1 } });
    expect(p.getStepCount()).toBe(0);
    expect(p.getState()).toBe('ACTIVE');
    p.stop();
  });

  it('refreshes the screen angle on orientationchange', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    const before = p.getPose()?.quaternion;
    win.screen.orientation.angle = 90;
    win.dispatch('orientationchange', {});
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    const after = p.getPose()?.quaternion;
    expect(after).not.toEqual(before);
    expect(quatLength(after!)).toBeCloseTo(1, 10);
    p.stop();
  });

  it('returns defensive pose copies', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    const a = p.getPose();
    expect(a).not.toBeNull();
    if (a !== null) {
      a.position.x = 999;
      a.quaternion.w = 999;
    }
    expect(p.getPose()?.position.x).toBe(0);
    expect(p.getPose()?.quaternion.w).not.toBe(999);
    p.stop();
  });

  it('reports poses through the onPose callback', async () => {
    const win = new FakeWindow();
    const onPose = jest.fn();
    const p = new DeviceTrackingProvider({ window: win, onPose });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    expect(onPose).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('survives a throwing onPose callback', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({
      window: win,
      onPose: () => {
        throw new Error('boom');
      },
    });
    await p.start();
    expect(() => win.dispatch('deviceorientation', orientationEvent(0, 90, 0))).not.toThrow();
    expect(p.getState()).toBe('ACTIVE');
    p.stop();
  });

  it('stop() removes every listener it added and resets the session', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    win.dispatch('deviceorientation', orientationEvent(0, 90, 0));
    win.dispatch('devicemotion', motionEvent(9.8));
    walkOneStep(win);
    expect(p.getStepCount()).toBe(1);

    p.stop();
    expect(p.getState()).toBe('STOPPED');
    expect(p.getPose()).toBeNull();
    expect(p.getFps()).toBe(0);
    expect(p.getStepCount()).toBe(0);
    expect(win.removed).toHaveLength(win.added.length);
    expect(win.removed.map((r) => r.type).sort()).toEqual(win.types().sort());
    for (const reg of win.added) {
      expect(win.removed.some((r) => r.handler === reg.handler)).toBe(true);
    }
    expect(() => p.stop()).not.toThrow();
    expect(p.getState()).toBe('STOPPED');
  });

  it('notifies and unsubscribes state listeners, and survives a throwing one', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    const states: string[] = [];
    const unsub = p.onStateChange((s) => states.push(s));
    p.onStateChange(() => {
      throw new Error('listener blew up');
    });
    await p.start();
    expect(() => win.dispatch('deviceorientation', orientationEvent(0, 90, 0))).not.toThrow();
    expect(states).toEqual(['INITIALIZING', 'ACTIVE']);

    unsub();
    p.stop();
    expect(states).toEqual(['INITIALIZING', 'ACTIVE']);
    expect(p.getState()).toBe('STOPPED');
  });

  it('start() is idempotent while already running', async () => {
    const win = new FakeWindow();
    const p = new DeviceTrackingProvider({ window: win });
    await p.start();
    const registered = win.added.length;
    await p.start();
    expect(win.added).toHaveLength(registered);
    p.stop();
  });
});
