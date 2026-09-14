/**
 * App wiring tests (no WebGL): the App is constructed with fake
 * tracking/game/coin/... collaborators and jsdom DOM only.
 */

import { App } from './App';
import type { AppOptions } from './App';
import type { CameraPose } from '../tracking/TrackingProvider';

function makePose(): CameraPose {
  return {
    position: { x: 1, y: 2, z: 3 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    timestamp: Date.now(),
    featureCount: 10,
    trackingFps: 30,
  };
}

function makeFakes() {
  const video = document.createElement('video');
  const cameraSource = {
    start: jest.fn().mockResolvedValue(null),
    stop: jest.fn(),
    getVideoElement: jest.fn().mockReturnValue(video),
    isStreaming: jest.fn().mockReturnValue(true),
  };
  const tracking = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    getPose: jest.fn().mockReturnValue(null),
    getState: jest.fn().mockReturnValue('ACTIVE'),
    onStateChange: jest.fn().mockReturnValue(() => undefined),
  };
  const player = {
    updateFromPose: jest.fn(),
    getPosition: jest.fn().mockReturnValue({ x: 0, y: 0, z: 0 }),
    distanceTo: jest.fn().mockReturnValue(1),
  };
  const coin = {
    spawn: jest.fn(),
    collect: jest.fn().mockReturnValue(false),
    reset: jest.fn(),
    isCollected: jest.fn().mockReturnValue(false),
    isPlaced: jest.fn().mockReturnValue(false),
    getPosition: jest.fn().mockReturnValue(null),
    update: jest.fn(),
    dispose: jest.fn(),
  };
  const beacon = {
    attachTo: jest.fn(),
    setVisible: jest.fn(),
    update: jest.fn(),
    dispose: jest.fn(),
  };
  const world = {
    computeSpawnPose: jest.fn().mockReturnValue({ x: 0, y: 0, z: -2.5 }),
    placeOnce: jest.fn().mockReturnValue(true),
  };
  const hud = {
    setScore: jest.fn(),
    setDistance: jest.fn(),
    showFinished: jest.fn(),
    reset: jest.fn(),
    destroy: jest.fn(),
  };
  const status = {
    setTracking: jest.fn(),
    destroy: jest.fn(),
  };
  const sound = {
    playCollect: jest.fn().mockResolvedValue('silent'),
  };
  const metrics = {
    startSession: jest.fn(),
    recordFrame: jest.fn(),
  };
  const game = {
    start: jest.fn().mockResolvedValue(undefined),
    requestCameraAndTracking: jest.fn().mockResolvedValue(undefined),
    update: jest.fn(),
    restart: jest.fn(),
    dispose: jest.fn(),
  };
  return {
    cameraSource,
    tracking,
    player,
    coin,
    beacon,
    world,
    hud,
    status,
    sound,
    metrics,
    game,
  };
}

function makeOptions(fakes: ReturnType<typeof makeFakes>): AppOptions {
  return { ...fakes };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('App wiring', () => {
  const apps: App[] = [];

  afterEach(() => {
    while (apps.length > 0) {
      const app = apps.pop();
      try {
        app?.destroy();
      } catch {
        // Teardown must never fail the suite.
      }
    }
  });

  it('constructs without WebGL and starts idle', () => {
    const app = new App(makeOptions(makeFakes()));
    apps.push(app);
    expect(app.isRunning()).toBe(false);
  });

  it('startAR runs camera -> tracking -> game and starts the loop', async () => {
    const fakes = makeFakes();
    const app = new App(makeOptions(fakes));
    apps.push(app);

    await app.startAR();

    expect(fakes.cameraSource.start).toHaveBeenCalledTimes(1);
    expect(fakes.tracking.start).toHaveBeenCalledTimes(1);
    expect(fakes.game.start).toHaveBeenCalled();
    expect(fakes.game.requestCameraAndTracking).toHaveBeenCalled();
    expect(fakes.metrics.startSession).toHaveBeenCalled();
    expect(app.isRunning()).toBe(true);

    // Let a few animation frames run with a null pose: nothing may throw.
    await sleep(10);
    expect(fakes.game.update).toHaveBeenCalled();
    expect(fakes.metrics.recordFrame).toHaveBeenCalled();
    expect(fakes.status.setTracking).toHaveBeenCalled();
    expect(app.isRunning()).toBe(true);
  });

  it('feeds tracking poses through the update loop without throwing', async () => {
    const fakes = makeFakes();
    const pose = makePose();
    fakes.tracking.getPose.mockReturnValue(pose);
    const app = new App(makeOptions(fakes));
    apps.push(app);

    await app.startAR();
    await sleep(10);

    expect(fakes.coin.update).toHaveBeenCalled();
    expect(fakes.beacon.update).toHaveBeenCalled();
    expect(fakes.game.update).toHaveBeenCalled();
    expect(fakes.metrics.recordFrame).toHaveBeenCalledWith(pose);
    expect(app.isRunning()).toBe(true);
  });

  it('guards against double-tap on start', async () => {
    const fakes = makeFakes();
    // Tracking starts first (see startAR's doc comment), so that is what
    // needs to hang to catch a concurrent second startAR() call in flight.
    let resolveStart!: () => void;
    fakes.tracking.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        })
    );
    const app = new App(makeOptions(fakes));
    apps.push(app);

    const first = app.startAR();
    const second = app.startAR();
    expect(fakes.tracking.start).toHaveBeenCalledTimes(1);
    resolveStart();
    await first;
    await second;

    expect(fakes.tracking.start).toHaveBeenCalledTimes(1);
    expect(fakes.cameraSource.start).toHaveBeenCalledTimes(1);
    expect(app.isRunning()).toBe(true);
  });

  it('surfaces camera errors on the StartScreen and re-enables the button', async () => {
    const fakes = makeFakes();
    fakes.cameraSource.start.mockRejectedValue(new Error('denied'));
    const app = new App(makeOptions(fakes));
    apps.push(app);

    await app.startAR();

    expect(app.isRunning()).toBe(false);
    expect(fakes.game.start).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('AR start failed: denied');
    const button = document.querySelector('button');
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('requests tracking (sensor permissions) before the camera', async () => {
    // Regression test: requesting the camera first burns the iOS Safari tap
    // that DeviceOrientationEvent.requestPermission() needs, so sensors get
    // silently denied even though the user only ever saw the camera prompt.
    // Tracking must be started - and its permission state checked - before
    // the camera is touched at all.
    const fakes = makeFakes();
    const callOrder: string[] = [];
    fakes.tracking.start.mockImplementation(async () => {
      callOrder.push('tracking');
    });
    fakes.cameraSource.start.mockImplementation(async () => {
      callOrder.push('camera');
      return null;
    });
    const app = new App(makeOptions(fakes));
    apps.push(app);

    await app.startAR();

    expect(callOrder).toEqual(['tracking', 'camera']);
  });

  it('bails out on denied sensor permission without ever requesting the camera', async () => {
    const fakes = makeFakes();
    const tracking = {
      ...fakes.tracking,
      getPermissionState: jest.fn().mockReturnValue('denied'),
    };
    const app = new App(makeOptions({ ...fakes, tracking }));
    apps.push(app);

    await app.startAR();

    expect(app.isRunning()).toBe(false);
    expect(fakes.cameraSource.start).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'motion & orientation access denied - allow it in the browser settings and try again'
    );
  });

  it('stopCamera stops tracking/camera/animation and resets running state', async () => {
    const fakes = makeFakes();
    const app = new App(makeOptions(fakes));
    apps.push(app);

    await app.startAR();
    expect(app.isRunning()).toBe(true);

    app.stopCamera();

    expect(app.isRunning()).toBe(false);
    expect(fakes.tracking.stop).toHaveBeenCalled();
    expect(fakes.cameraSource.stop).toHaveBeenCalled();

    const updates = fakes.game.update.mock.calls.length;
    await sleep(20);
    expect(fakes.game.update.mock.calls.length).toBe(updates);
  });

  it('destroy stops everything and disposes collaborators', async () => {
    const fakes = makeFakes();
    const app = new App(makeOptions(fakes));
    apps.push(app);

    await app.startAR();
    app.destroy();
    apps.pop();

    expect(fakes.tracking.stop).toHaveBeenCalled();
    expect(fakes.cameraSource.stop).toHaveBeenCalled();
    expect(fakes.game.dispose).toHaveBeenCalled();
    expect(fakes.hud.destroy).toHaveBeenCalled();
    expect(fakes.status.destroy).toHaveBeenCalled();
    expect(app.isRunning()).toBe(false);
  });
});
