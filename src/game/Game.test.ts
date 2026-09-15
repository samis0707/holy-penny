import { MockTrackingProvider } from '../tracking/TrackingProvider';
import type { CameraPose } from '../tracking/TrackingProvider';
import type { GameBeacon, GameCoin, GameHUD, GamePlayer, GameStatus, GameWorld } from './Game';
import { Game } from './Game';

interface Vec {
  x: number;
  y: number;
  z: number;
}

function makePose(x: number, y: number, z: number, timestamp = 1000): CameraPose {
  return {
    position: { x, y, z },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    timestamp,
    featureCount: 10,
    trackingFps: 30,
  };
}

class FakeCoin implements GameCoin {
  spawnCalls = 0;
  private placed = false;
  private collected = false;
  private pos: Vec | null = null;

  spawn(p: Vec): void {
    this.spawnCalls += 1;
    if (this.placed) {
      return;
    }
    this.pos = { x: p.x, y: p.y, z: p.z };
    this.placed = true;
    this.collected = false;
  }

  collect(): boolean {
    if (!this.placed || this.collected) {
      return false;
    }
    this.collected = true;
    return true;
  }

  reset(): void {
    this.placed = false;
    this.collected = false;
    this.pos = null;
  }

  isCollected(): boolean {
    return this.collected;
  }

  isPlaced(): boolean {
    return this.placed;
  }

  getPosition(): Vec | null {
    if (this.pos === null) {
      return null;
    }
    return { x: this.pos.x, y: this.pos.y, z: this.pos.z };
  }
}

class FakeBeacon implements GameBeacon {
  position: Vec | null = null;
  visible = false;
  attachCalls = 0;
  setVisibleCalls: boolean[] = [];

  attachTo(p: Vec): void {
    this.attachCalls += 1;
    this.position = { x: p.x, y: p.y, z: p.z };
    this.visible = true;
  }

  setVisible(v: boolean): void {
    this.setVisibleCalls.push(v);
    this.visible = v;
  }
}

class FakePlayer implements GamePlayer {
  private position: Vec = { x: 0, y: 0, z: 0 };

  updateFromPose(p: { position: Vec } | null): void {
    if (p === null || p === undefined) {
      return;
    }
    this.position = { x: p.position.x, y: p.position.y, z: p.position.z };
  }

  getPosition(): Vec {
    return { x: this.position.x, y: this.position.y, z: this.position.z };
  }

  distanceTo(t: Vec): number {
    const dx = this.position.x - t.x;
    const dy = this.position.y - t.y;
    const dz = this.position.z - t.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

class FakeWorld implements GameWorld {
  placeOnceCalls = 0;
  private placed = false;

  computeSpawnPose(
    from: { position: Vec; quaternion: { x: number; y: number; z: number; w: number } },
    opts?: { distance?: number }
  ): Vec {
    const d = opts?.distance ?? 2.5;
    return { x: from.position.x, y: from.position.y - 0.2, z: from.position.z - d };
  }

  placeOnce(
    coin: { spawn(p: Vec): void },
    pose: {
      position: Vec;
      quaternion: { x: number; y: number; z: number; w: number };
      timestamp: number;
    }
  ): boolean {
    this.placeOnceCalls += 1;
    if (this.placed) {
      return false;
    }
    const spawn = this.computeSpawnPose(pose);
    coin.spawn(spawn);
    this.placed = true;
    return true;
  }
}

class FakeHUD implements GameHUD {
  scoreCalls: Array<{ c: number; t: number }> = [];
  distanceCalls: Array<number | null> = [];
  finishedCalls = 0;
  resetCalls = 0;

  setScore(c: number, t: number): void {
    this.scoreCalls.push({ c, t });
  }

  setDistance(m: number | null): void {
    this.distanceCalls.push(m);
  }

  showFinished(): void {
    this.finishedCalls += 1;
  }

  reset(): void {
    this.resetCalls += 1;
  }
}

class FakeStatus implements GameStatus {
  calls: unknown[] = [];
  lastState: unknown = null;

  setTracking(s: unknown): void {
    this.calls.push(s);
    this.lastState = s;
  }
}

function setup(opts?: {
  threshold?: number;
  spawnDistance?: number;
  totalCoins?: number;
  withWorld?: boolean;
  soundRejects?: boolean;
}) {
  const tracking = new MockTrackingProvider();
  const player = new FakePlayer();
  const coin = new FakeCoin();
  const beacon = new FakeBeacon();
  const world = opts?.withWorld === false ? null : new FakeWorld();
  const hud = new FakeHUD();
  const status = new FakeStatus();
  const soundCalls: number[] = [];
  const sound = {
    playCollect(): Promise<unknown> {
      soundCalls.push(1);
      if (opts?.soundRejects === true) {
        return Promise.reject(new Error('no audio'));
      }
      return Promise.resolve('ok');
    },
  };
  const game = new Game({
    tracking,
    player,
    coin,
    beacon,
    world,
    hud,
    status,
    sound,
    collectThreshold: opts?.threshold,
    spawnDistance: opts?.spawnDistance,
    totalCoins: opts?.totalCoins,
  });
  return { tracking, player, coin, beacon, world, hud, status, soundCalls, game };
}

async function startAndPlay(
  ctx: ReturnType<typeof setup>,
  camX = 0,
  camY = 0,
  camZ = 0
): Promise<void> {
  await ctx.game.start();
  await ctx.game.requestCameraAndTracking();
  ctx.tracking.setPose(makePose(camX, camY, camZ));
  ctx.tracking.setState('ACTIVE');
  ctx.game.update();
}

describe('Game', () => {
  it('inits LOADING with score 0', () => {
    const { game } = setup();
    expect(game.getState()).toBe('LOADING');
    expect(game.getScore()).toBe(0);
    expect(game.getTotal()).toBe(1);
    expect(game.getCoinDistance()).toBeNull();
  });

  it('start transitions LOADING to READY and is idempotent', async () => {
    const { game } = setup();
    await game.start();
    expect(game.getState()).toBe('READY');
    await game.start();
    expect(game.getState()).toBe('READY');
  });

  it('requestCamera flow places coin once and keeps spot on moved camera', async () => {
    const ctx = setup({ withWorld: false });
    await ctx.game.start();
    await ctx.game.requestCameraAndTracking();
    expect(ctx.game.getState()).toBe('INITIALIZING_TRACKING');
    ctx.tracking.setPose(makePose(0, 0, 0));
    ctx.tracking.setState('ACTIVE');
    ctx.game.update();
    expect(ctx.game.getState()).toBe('PLAYING');
    const first = ctx.coin.getPosition();
    expect(first).not.toBeNull();
    expect(ctx.coin.isPlaced()).toBe(true);
    expect(ctx.coin.spawnCalls).toBe(1);
    // Fallback spawn ahead -Z with height offset.
    expect(first?.x).toBeCloseTo(0, 10);
    expect(first?.y).toBeCloseTo(-0.2, 10);
    expect(first?.z).toBeCloseTo(-2.5, 10);
    // Move camera and update again: spot must not change, no re-place.
    ctx.tracking.setPose(makePose(5, 0, 0, 2000));
    ctx.game.update();
    const second = ctx.coin.getPosition();
    expect(second).toEqual(first);
    expect(ctx.coin.spawnCalls).toBe(1);
  });

  it('uses world.placeOnce when world provided, exactly once', async () => {
    const ctx = setup({ withWorld: true });
    expect(ctx.world).not.toBeNull();
    await ctx.game.start();
    await ctx.game.requestCameraAndTracking();
    ctx.tracking.setPose(makePose(0, 1, 0));
    ctx.tracking.setState('ACTIVE');
    ctx.game.update();
    expect(ctx.game.getState()).toBe('PLAYING');
    expect(ctx.world?.placeOnceCalls).toBe(1);
    const spot = ctx.coin.getPosition();
    expect(spot).not.toBeNull();
    ctx.tracking.setPose(makePose(1, 1, 1, 2000));
    ctx.game.update();
    expect(ctx.world?.placeOnceCalls).toBe(1);
    expect(ctx.coin.getPosition()).toEqual(spot);
  });

  it('collects when within threshold and finishes single coin game', async () => {
    const ctx = setup({ withWorld: false });
    await startAndPlay(ctx, 0, 0, 0);
    expect(ctx.game.getState()).toBe('PLAYING');
    const coinPos = ctx.coin.getPosition();
    expect(coinPos).not.toBeNull();
    if (coinPos === null) {
      throw new Error('coin not placed');
    }
    // Drive to 0.5m from the coin.
    ctx.tracking.setPose(makePose(coinPos.x + 0.5, coinPos.y, coinPos.z, 2000));
    ctx.game.update();
    expect(ctx.game.getState()).toBe('FINISHED');
    expect(ctx.game.getScore()).toBe(1);
    expect(ctx.game.getTotal()).toBe(1);
    expect(ctx.coin.isCollected()).toBe(true);
    expect(ctx.beacon.visible).toBe(false);
    expect(ctx.hud.finishedCalls).toBe(1);
    expect(ctx.hud.scoreCalls[ctx.hud.scoreCalls.length - 1]).toEqual({ c: 1, t: 1 });
    expect(ctx.soundCalls.length).toBe(1);
  });

  it('stays PLAYING when at 1.01m (beyond default 1.0m threshold)', async () => {
    const ctx = setup({ withWorld: false });
    await startAndPlay(ctx, 0, 0, 0);
    const coinPos = ctx.coin.getPosition();
    if (coinPos === null) {
      throw new Error('coin not placed');
    }
    ctx.tracking.setPose(makePose(coinPos.x + 1.01, coinPos.y, coinPos.z, 2000));
    ctx.game.update();
    expect(ctx.game.getState()).toBe('PLAYING');
    expect(ctx.game.getScore()).toBe(0);
    expect(ctx.coin.isCollected()).toBe(false);
  });

  it('does not collect when LOST, stays PLAYING with null distance', async () => {
    const ctx = setup({ withWorld: false });
    await startAndPlay(ctx, 0, 0, 0);
    expect(ctx.game.getState()).toBe('PLAYING');
    ctx.tracking.setState('LOST');
    ctx.tracking.setPose(null);
    ctx.game.update();
    expect(ctx.game.getState()).toBe('PLAYING');
    expect(ctx.game.getScore()).toBe(0);
    expect(ctx.coin.isCollected()).toBe(false);
    expect(ctx.game.getCoinDistance()).toBeNull();
    const lastDistance = ctx.hud.distanceCalls[ctx.hud.distanceCalls.length - 1];
    expect(lastDistance).toBeNull();
  });

  it('forwards tracking states to status (LOST passthrough)', async () => {
    const ctx = setup();
    await ctx.game.start();
    ctx.tracking.setState('LOST');
    expect(ctx.status.lastState).toBe('LOST');
    ctx.tracking.setState('ACTIVE');
    expect(ctx.status.lastState).toBe('ACTIVE');
  });

  it('restart after collect resets to PLAYING with same spawn', async () => {
    const ctx = setup({ withWorld: false });
    await startAndPlay(ctx, 0, 0, 0);
    const spot = ctx.coin.getPosition();
    if (spot === null) {
      throw new Error('coin not placed');
    }
    ctx.tracking.setPose(makePose(spot.x + 0.2, spot.y, spot.z, 2000));
    ctx.game.update();
    expect(ctx.game.getState()).toBe('FINISHED');
    ctx.game.restart();
    expect(ctx.game.getState()).toBe('PLAYING');
    expect(ctx.game.getScore()).toBe(0);
    expect(ctx.coin.isCollected()).toBe(false);
    expect(ctx.coin.isPlaced()).toBe(true);
    expect(ctx.coin.getPosition()).toEqual(spot);
    expect(ctx.beacon.visible).toBe(true);
    expect(ctx.hud.resetCalls).toBe(1);
  });

  it('throws on illegal requestCameraAndTracking before start', async () => {
    const { game } = setup();
    await expect(game.requestCameraAndTracking()).rejects.toThrow(Error);
    expect(game.getState()).toBe('LOADING');
  });

  it('clamps threshold <=0 to the 1.0m default behavior', async () => {
    const ctx = setup({ withWorld: false, threshold: 0 });
    await startAndPlay(ctx, 0, 0, 0);
    const coinPos = ctx.coin.getPosition();
    if (coinPos === null) {
      throw new Error('coin not placed');
    }
    // With the clamped 1.0m default, 0.9m collects.
    ctx.tracking.setPose(makePose(coinPos.x + 0.9, coinPos.y, coinPos.z, 2000));
    ctx.game.update();
    expect(ctx.game.getState()).toBe('FINISHED');
    expect(ctx.game.getScore()).toBe(1);
  });

  it('dispose unsubscribes without crashing on later tracking changes', async () => {
    const ctx = setup();
    await ctx.game.start();
    const callsBefore = ctx.status.calls.length;
    ctx.game.dispose();
    ctx.tracking.setState('LOST');
    ctx.tracking.setState('ACTIVE');
    expect(ctx.status.calls.length).toBe(callsBefore);
    // Second dispose is safe.
    ctx.game.dispose();
    ctx.game.update();
  });

  it('update is a no-op before tracking is initialized', async () => {
    const ctx = setup({ withWorld: false });
    ctx.game.update();
    expect(ctx.game.getState()).toBe('LOADING');
    expect(ctx.coin.isPlaced()).toBe(false);
    await ctx.game.start();
    ctx.game.update();
    expect(ctx.game.getState()).toBe('READY');
    expect(ctx.coin.isPlaced()).toBe(false);
  });

  it('sound failure does not break collection', async () => {
    const ctx = setup({ withWorld: false, soundRejects: true });
    await startAndPlay(ctx, 0, 0, 0);
    const coinPos = ctx.coin.getPosition();
    if (coinPos === null) {
      throw new Error('coin not placed');
    }
    ctx.tracking.setPose(makePose(coinPos.x + 0.3, coinPos.y, coinPos.z, 2000));
    ctx.game.update();
    expect(ctx.game.getState()).toBe('FINISHED');
    expect(ctx.game.getScore()).toBe(1);
  });
});
