import type { TrackingProvider, TrackingState } from '../tracking/TrackingProvider';

export type GameState =
  | 'LOADING'
  | 'READY'
  | 'REQUEST_CAMERA'
  | 'INITIALIZING_TRACKING'
  | 'PLAYING'
  | 'COIN_COLLECTED'
  | 'FINISHED';

export interface GameHUD {
  setScore(c: number, t: number): void;
  setDistance(m: number | null): void;
  showFinished(): void;
  reset(): void;
}

export interface GameStatus {
  setTracking(s: TrackingState, info?: unknown): void;
}

export interface GameCoin {
  spawn(p: { x: number; y: number; z: number }): void;
  collect(): boolean;
  reset(): void;
  isCollected(): boolean;
  isPlaced(): boolean;
  getPosition(): { x: number; y: number; z: number } | null;
}

export interface GameBeacon {
  attachTo(p: { x: number; y: number; z: number }): void;
  setVisible(v: boolean): void;
}

export interface GamePlayer {
  updateFromPose(p: { position: { x: number; y: number; z: number } } | null): void;
  getPosition(): { x: number; y: number; z: number };
  distanceTo(t: { x: number; y: number; z: number }): number;
}

export interface GameWorld {
  computeSpawnPose(
    from: {
      position: { x: number; y: number; z: number };
      quaternion: { x: number; y: number; z: number; w: number };
    },
    opts?: { distance?: number }
  ): { x: number; y: number; z: number };
  placeOnce(
    coin: { spawn(p: { x: number; y: number; z: number }): void },
    pose: {
      position: { x: number; y: number; z: number };
      quaternion: { x: number; y: number; z: number; w: number };
      timestamp: number;
    }
  ): boolean;
}

export interface GameOptions {
  tracking: TrackingProvider;
  player: GamePlayer;
  coin: GameCoin;
  beacon: GameBeacon;
  world?: GameWorld | null;
  hud?: GameHUD | null;
  status?: GameStatus | null;
  sound?: { playCollect(): Promise<unknown> } | null;
  collectThreshold?: number;
  spawnDistance?: number;
  totalCoins?: number;
}

/**
 * Collection radius. Generous on purpose: position tracking here is pure
 * dead-reckoning from a fixed assumed step length (see
 * `DeviceTrackingProvider`'s `stepLengthMeters`), not a real measurement of
 * how far the player actually walked, so a tight radius means small,
 * unavoidable mismatches between assumed and real stride length can leave
 * the coin permanently just out of reach.
 */
const DEFAULT_THRESHOLD = 1.0;
const DEFAULT_SPAWN_DISTANCE = 2.5;
const DEFAULT_TOTAL = 1;

function normalizeThreshold(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) {
    return DEFAULT_THRESHOLD;
  }
  return v;
}

export class Game {
  private readonly tracking: TrackingProvider;
  private readonly player: GamePlayer;
  private readonly coin: GameCoin;
  private readonly beacon: GameBeacon;
  private readonly world: GameWorld | null;
  private readonly hud: GameHUD | null;
  private readonly status: GameStatus | null;
  private readonly sound: { playCollect(): Promise<unknown> } | null;
  private readonly threshold: number;
  private readonly spawnDistance: number;
  private readonly total: number;

  private state: GameState = 'LOADING';
  private score = 0;
  private coinDistance: number | null = null;
  private savedSpawn: { x: number; y: number; z: number } | null = null;
  private hasPlaced = false;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: GameOptions) {
    this.tracking = opts.tracking;
    this.player = opts.player;
    this.coin = opts.coin;
    this.beacon = opts.beacon;
    this.world = opts.world ?? null;
    this.hud = opts.hud ?? null;
    this.status = opts.status ?? null;
    this.sound = opts.sound ?? null;
    this.threshold = normalizeThreshold(opts.collectThreshold);
    this.spawnDistance =
      opts.spawnDistance === undefined || !Number.isFinite(opts.spawnDistance)
        ? DEFAULT_SPAWN_DISTANCE
        : opts.spawnDistance;
    const total = opts.totalCoins ?? DEFAULT_TOTAL;
    this.total = Number.isFinite(total) && total >= 1 ? Math.floor(total) : DEFAULT_TOTAL;
  }

  getState(): GameState {
    return this.state;
  }

  getScore(): number {
    return this.score;
  }

  getTotal(): number {
    return this.total;
  }

  getCoinDistance(): number | null {
    return this.coinDistance;
  }

  async start(): Promise<void> {
    if (this.state !== 'LOADING') {
      return;
    }
    this.unsubscribe = this.tracking.onStateChange((s: TrackingState) => {
      this.status?.setTracking(s);
    });
    this.state = 'READY';
  }

  async requestCameraAndTracking(): Promise<void> {
    if (this.state !== 'READY') {
      throw new Error('Game: requestCameraAndTracking only allowed from READY');
    }
    this.state = 'REQUEST_CAMERA';
    await this.tracking.start();
    this.state = 'INITIALIZING_TRACKING';
  }

  update(_dtSec?: number): void {
    void _dtSec;
    if (this.state !== 'INITIALIZING_TRACKING' && this.state !== 'PLAYING') {
      return;
    }
    const pose = this.tracking.getPose();
    this.player.updateFromPose(pose);
    if (this.state === 'INITIALIZING_TRACKING') {
      if (pose === null) {
        this.coinDistance = null;
        this.hud?.setDistance(null);
        return;
      }
      this.placeCoinOnce(pose);
      this.state = 'PLAYING';
    }
    if (this.state !== 'PLAYING') {
      return;
    }
    if (pose === null) {
      this.coinDistance = null;
      this.hud?.setDistance(null);
      return;
    }
    const coinPos = this.coin.getPosition();
    if (coinPos === null || this.coin.isCollected()) {
      this.coinDistance = null;
      return;
    }
    const d = this.player.distanceTo(coinPos);
    this.coinDistance = d;
    this.hud?.setDistance(d);
    if (!this.coin.isCollected() && d < this.threshold) {
      this.collectCoin();
    }
  }

  collectCoin(): boolean {
    if (this.state !== 'PLAYING') {
      return false;
    }
    if (!this.coin.isPlaced()) {
      return false;
    }
    if (this.coin.isCollected()) {
      return false;
    }
    if (this.coin.getPosition() === null) {
      return false;
    }
    const ok = this.coin.collect();
    if (!ok) {
      return false;
    }
    this.score += 1;
    this.beacon.setVisible(false);
    this.hud?.setScore(this.score, this.total);
    this.hud?.setDistance(null);
    this.coinDistance = null;
    if (this.sound) {
      try {
        const r = this.sound.playCollect();
        if (r !== null && r !== undefined && typeof (r as Promise<unknown>).catch === 'function') {
          void (r as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        /* ignore sound failures */
      }
    }
    this.state = 'COIN_COLLECTED';
    if (this.score >= this.total) {
      this.hud?.showFinished();
      this.state = 'FINISHED';
    }
    return true;
  }

  restart(): void {
    if (this.state !== 'PLAYING' && this.state !== 'COIN_COLLECTED' && this.state !== 'FINISHED') {
      return;
    }
    this.score = 0;
    this.coinDistance = null;
    this.coin.reset();
    if (this.savedSpawn !== null) {
      this.coin.spawn({ x: this.savedSpawn.x, y: this.savedSpawn.y, z: this.savedSpawn.z });
      this.beacon.attachTo({ x: this.savedSpawn.x, y: this.savedSpawn.y, z: this.savedSpawn.z });
    }
    this.beacon.setVisible(true);
    this.hud?.reset();
    this.state = 'PLAYING';
  }

  dispose(): void {
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        /* ignore unsubscribe failures */
      }
      this.unsubscribe = null;
    }
  }

  private placeCoinOnce(pose: {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
    timestamp: number;
  }): void {
    if (this.hasPlaced) {
      return;
    }
    if (this.coin.isPlaced()) {
      const existing = this.coin.getPosition();
      if (existing !== null) {
        this.savedSpawn = { x: existing.x, y: existing.y, z: existing.z };
        this.hasPlaced = true;
        this.beacon.attachTo({ x: existing.x, y: existing.y, z: existing.z });
        this.beacon.setVisible(true);
      }
      return;
    }
    if (this.world !== null) {
      this.world.placeOnce(this.coin, pose);
      const placed = this.coin.getPosition();
      if (placed === null) {
        const fallback = {
          x: pose.position.x,
          y: pose.position.y - 0.2,
          z: pose.position.z - this.spawnDistance,
        };
        this.coin.spawn(fallback);
      }
    } else {
      this.coin.spawn({
        x: pose.position.x,
        y: pose.position.y - 0.2,
        z: pose.position.z - this.spawnDistance,
      });
    }
    const spawn = this.coin.getPosition();
    if (spawn !== null) {
      this.savedSpawn = { x: spawn.x, y: spawn.y, z: spawn.z };
      this.hasPlaced = true;
      this.beacon.attachTo({ x: spawn.x, y: spawn.y, z: spawn.z });
      this.beacon.setVisible(true);
    }
  }
}
