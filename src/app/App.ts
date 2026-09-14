/**
 * App - Main application class
 * Orchestrates camera, tracking, rendering, and game logic.
 *
 * Phase 2 (camera feed) + Phases 4+11 (Lanes A-D wiring, iOS UX):
 * - CameraSource for getUserMedia video
 * - DeviceTrackingProvider (or injected TrackingProvider) for camera poses
 * - Player / ARWorld / Coin / Beacon / Game (Lanes B+C)
 * - HUD / TrackingStatus / StartScreen (Lane D + iOS polish)
 * - SoundPlayer / TrackingMetrics (Phase 11)
 *
 * The constructor never throws when WebGL is unavailable (jsdom tests):
 * renderer/scene/camera creation falls back to no-op stubs under Jest.
 */

import { CameraSource, cameraSource } from '../tracking/CameraSource';
import type { TrackingProvider, CameraPose } from '../tracking/TrackingProvider';
import { DeviceTrackingProvider } from '../tracking/DeviceTrackingProvider';
import { StartScreen } from '../ui/StartScreen';
import { HUD } from '../ui/HUD';
import { TrackingStatus } from '../ui/TrackingStatus';
import { Game } from '../game/Game';
import type {
  GameBeacon,
  GameCoin,
  GameHUD,
  GamePlayer,
  GameStatus,
  GameWorld,
} from '../game/Game';
import { Player } from '../game/Player';
import { Coin } from '../game/Coin';
import { Beacon } from '../game/Beacon';
import { ARWorld } from '../rendering/ARWorld';
import { SoundPlayer } from '../utils/sound';
import { TrackingMetrics } from '../utils/trackingMetrics';
import * as THREE from 'three';

/** Minimal camera surface App needs (real CameraSource or a test fake). */
export interface AppCameraSource {
  start(): Promise<unknown>;
  stop(): void;
  getVideoElement(): HTMLVideoElement;
  isStreaming(): boolean;
}

/** GameCoin plus the optional visual tick the real Coin provides. */
export interface AppCoin extends GameCoin {
  update?(dtSec: number, elapsedSec: number): void;
  dispose?(): void;
}

/** GameBeacon plus the optional visual tick the real Beacon provides. */
export interface AppBeacon extends GameBeacon {
  update?(dtSec: number, elapsedSec: number): void;
  dispose?(): void;
}

/** GameHUD plus the optional DOM handle the real HUD provides. */
export interface AppHud extends GameHUD {
  element?: HTMLElement;
  destroy?(): void;
}

/** GameStatus plus the optional DOM handle the real TrackingStatus provides. */
export interface AppStatus extends GameStatus {
  element?: HTMLElement;
  destroy?(): void;
}

/** Minimal sound surface (real SoundPlayer or a test fake). */
export interface AppSound {
  playCollect(): Promise<unknown>;
}

/** Minimal metrics surface (real TrackingMetrics or a test fake). */
export interface AppMetrics {
  startSession(): void;
  recordFrame(pose: CameraPose | null, atMs?: number): void;
}

/** Minimal game surface (real Game or a test fake). */
export interface AppGame {
  start(): Promise<void>;
  requestCameraAndTracking(): Promise<void>;
  update(dtSec?: number): void;
  restart?(): void;
  dispose?(): void;
}

export interface AppOptions {
  canvas?: HTMLCanvasElement;
  /** Long-side field of view of the physical camera, in degrees. */
  cameraFovDeg?: number;
  cameraOptions?: ConstructorParameters<typeof CameraSource>[0];
  cameraSource?: AppCameraSource;
  tracking?: TrackingProvider;
  player?: GamePlayer;
  coin?: AppCoin;
  beacon?: AppBeacon;
  world?: GameWorld;
  hud?: AppHud;
  status?: AppStatus;
  sound?: AppSound;
  metrics?: AppMetrics;
  game?: AppGame;
}

/**
 * Field of view of the physical camera along the LONG side of its frame.
 * ~65 deg matches the main rear camera of current phones; the vertical FOV
 * actually used for rendering is derived from this plus the video and
 * screen aspect ratios (see App.updateCameraProjection).
 */
const DEFAULT_SENSOR_FOV_DEG = 65;
const MIN_FOV_DEG = 30;
const MAX_FOV_DEG = 120;

/** Used until the stream reports its real dimensions. */
const FALLBACK_VIDEO_WIDTH = 720;
const FALLBACK_VIDEO_HEIGHT = 1280;

function clampFov(deg: number): number {
  if (!Number.isFinite(deg)) {
    return DEFAULT_SENSOR_FOV_DEG;
  }
  return Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, deg));
}

function isTestEnv(): boolean {
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const proc = g['process'] as { env?: Record<string, unknown> } | undefined;
    return !!proc?.env?.['JEST_WORKER_ID'];
  } catch {
    return false;
  }
}

export class App {
  private cameraSource: AppCameraSource;
  private startScreen: StartScreen;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private videoTexture: THREE.VideoTexture | null = null;
  private animationFrameId = 0;

  // Camera feed background: rendered as a screen-space pass before the AR
  // scene, so it always fills the viewport no matter where tracking puts
  // the virtual camera.
  private bgScene: THREE.Scene | null = null;
  private bgCamera: THREE.OrthographicCamera | null = null;
  private bgMesh: THREE.Mesh | null = null;
  private videoWidth = 0;
  private videoHeight = 0;
  private readonly sensorFovDeg: number;
  private orientationResizeTimer: ReturnType<typeof setTimeout> | null = null;

  private tracking: TrackingProvider;
  private player: GamePlayer;
  private coin: AppCoin;
  private beacon: AppBeacon;
  private world: GameWorld;
  private hud: AppHud;
  private status: AppStatus;
  private sound: AppSound;
  private metrics: AppMetrics;
  private game: AppGame;

  private starting = false;
  private started = false;
  private wasPlayingOnHide = false;
  private lastFrameMs = 0;
  private elapsedSec = 0;
  private trackingUnsubscribe: (() => void) | null = null;

  private readonly handleResize = (): void => {
    this.onResize();
  };

  private readonly handleOrientationChange = (): void => {
    // iOS still reports the previous viewport size in this event, so resize
    // once now and once more after the rotation has settled.
    this.onResize();
    if (this.orientationResizeTimer !== null) {
      clearTimeout(this.orientationResizeTimer);
    }
    this.orientationResizeTimer = setTimeout(() => {
      this.orientationResizeTimer = null;
      this.onResize();
    }, 300);
  };

  private readonly handleVisibilityChange = (): void => {
    if (typeof document === 'undefined') {
      return;
    }
    if (document.hidden) {
      this.wasPlayingOnHide = this.started && this.animationFrameId !== 0;
      this.stopAnimation();
    } else if (this.wasPlayingOnHide && this.started) {
      this.wasPlayingOnHide = false;
      this.lastFrameMs = performance.now();
      this.startAnimation();
    }
  };

  constructor(options: AppOptions = {}) {
    this.sensorFovDeg = clampFov(options.cameraFovDeg ?? DEFAULT_SENSOR_FOV_DEG);
    this.cameraSource = options.cameraSource
      ? options.cameraSource
      : options.cameraOptions
        ? new CameraSource(options.cameraOptions)
        : cameraSource;

    // Initialize Three.js (stubs under Jest where WebGL is unavailable).
    this.initThreeJS(options.canvas);

    // Tracking + game world (Lane A/B). Real device-sensor tracking:
    // orientation from the gyro/compass, translation from detected steps.
    // (AlvaTrackingProvider is a placeholder that reports a static pose and
    // is deliberately not wired up - see its file header.)
    this.tracking = options.tracking ?? new DeviceTrackingProvider();
    this.player = options.player ?? new Player();
    this.world = options.world ?? new ARWorld();
    this.coin = options.coin ?? new Coin(this.scene);
    this.beacon = options.beacon ?? new Beacon(this.scene);
    this.hud = options.hud ?? new HUD(undefined, { onRestart: () => this.game.restart?.() });
    this.status = options.status ?? new TrackingStatus();
    this.sound = options.sound ?? new SoundPlayer(this.resolveBaseUrl());
    this.metrics = options.metrics ?? new TrackingMetrics();
    this.game =
      options.game ??
      new Game({
        tracking: this.tracking,
        player: this.player,
        coin: this.coin,
        beacon: this.beacon,
        world: this.world,
        hud: this.hud,
        status: this.status,
        sound: this.sound,
      });

    // Overlays stay hidden behind the start screen until AR starts.
    this.setOverlaysVisible(false);

    // Initialize UI
    this.startScreen = new StartScreen({
      onStart: () => this.startAR(),
    });

    // Handle window resize / orientation and backgrounding (Phase 11).
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('orientationchange', this.handleOrientationChange);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  /**
   * Whether the AR session is currently running.
   */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * Initialize Three.js scene, camera, and renderer.
   * Under Jest (no WebGL) fall back to no-op stubs so imports stay side-effect free.
   */
  private initThreeJS(canvas?: HTMLCanvasElement): void {
    if (isTestEnv()) {
      this.scene = this.createStubScene();
      this.camera = this.createStubCamera();
      this.renderer = this.createStubRenderer();
      return;
    }
    try {
      // Scene. No background colour of its own: the camera feed is drawn as
      // a full-screen pass before the AR scene on every frame.
      this.scene = new THREE.Scene();
      this.scene.background = null;

      // Camera. Starts at the tracking origin; the FOV is replaced by one
      // derived from the real camera stream as soon as it reports its size.
      const aspect = window.innerWidth / window.innerHeight;
      this.camera = new THREE.PerspectiveCamera(DEFAULT_SENSOR_FOV_DEG, aspect, 0.05, 1000);
      this.camera.position.set(0, 0, 0);

      // Renderer. autoClear is off because every frame renders two passes:
      // camera feed (screen space) and AR scene (world space).
      const rendererOpts: THREE.WebGLRendererParameters = canvas
        ? { antialias: true, alpha: true, canvas }
        : { antialias: true, alpha: true };
      this.renderer = new THREE.WebGLRenderer(rendererOpts);
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      // Capped: full DPR on a modern phone costs frames for no visible gain.
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      document.body.appendChild(this.renderer.domElement);

      // Screen-space background pass for the camera feed.
      this.bgScene = new THREE.Scene();
      this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      this.updateCameraProjection();

      // Add ambient light
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
      this.scene.add(ambientLight);

      // Add directional light
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
      directionalLight.position.set(5, 10, 7);
      this.scene.add(directionalLight);
    } catch {
      // WebGL unavailable: degrade to stubs instead of throwing from the constructor.
      this.scene = this.createStubScene();
      this.camera = this.createStubCamera();
      this.renderer = this.createStubRenderer();
    }
  }

  private createStubScene(): THREE.Scene {
    const scene = {
      background: null,
      add: (): void => undefined,
      remove: (): void => undefined,
    };
    return scene as unknown as THREE.Scene;
  }

  private createStubCamera(): THREE.PerspectiveCamera {
    const position = {
      x: 0,
      y: 0,
      z: 5,
      set: (x: number, y: number, z: number): void => {
        position.x = x;
        position.y = y;
        position.z = z;
      },
    };
    const quaternion = {
      x: 0,
      y: 0,
      z: 0,
      w: 1,
      set: (x: number, y: number, z: number, w: number): void => {
        quaternion.x = x;
        quaternion.y = y;
        quaternion.z = z;
        quaternion.w = w;
      },
    };
    const camera = {
      fov: DEFAULT_SENSOR_FOV_DEG,
      aspect: 1,
      position,
      quaternion,
      updateProjectionMatrix: (): void => undefined,
    };
    return camera as unknown as THREE.PerspectiveCamera;
  }

  private createStubRenderer(): THREE.WebGLRenderer {
    const canvas = document.createElement('canvas');
    const renderer = {
      domElement: canvas,
      autoClear: false,
      setSize: (): void => undefined,
      setPixelRatio: (): void => undefined,
      setClearColor: (): void => undefined,
      clear: (): void => undefined,
      clearDepth: (): void => undefined,
      render: (): void => undefined,
      dispose: (): void => undefined,
    };
    document.body.appendChild(canvas);
    return renderer as unknown as THREE.WebGLRenderer;
  }

  /**
   * Base URL for runtime assets (sounds). Derived from document.baseURI so
   * GitHub Pages sub-path builds resolve, without referencing import.meta
   * (which would break ts-jest CommonJS execution).
   */
  private resolveBaseUrl(): string {
    try {
      if (typeof document !== 'undefined' && typeof document.baseURI === 'string') {
        return new URL('.', document.baseURI).pathname;
      }
    } catch {
      // Fall through to the root default.
    }
    return '/';
  }

  /**
   * Start the full AR session: camera -> tracking -> game.
   * Guarded against double-tap; failures surface on the StartScreen.
   */
  async startAR(): Promise<void> {
    if (this.starting || this.started) {
      return;
    }
    this.starting = true;
    try {
      this.startScreen.setStatus('Starting camera...');
      this.startScreen.setButtonEnabled(false);

      // Start camera
      await this.cameraSource.start();

      // Video element is only available once the camera runs.
      const video = this.cameraSource.getVideoElement();
      this.setupVideoBackground(video);

      // Start tracking, then drive the game through READY -> PLAYING.
      this.startScreen.setStatus('Starting tracking...');
      await this.tracking.start();

      // Sensor access is the one failure we cannot paper over: without it
      // there is no pose, so say so instead of hanging on a frozen scene.
      const trackingIssue = this.describeTrackingIssue();
      if (trackingIssue !== null) {
        throw new Error(trackingIssue);
      }

      await this.game.start();
      await this.game.requestCameraAndTracking();

      this.metrics.startSession();
      if (this.trackingUnsubscribe) {
        this.trackingUnsubscribe();
      }
      this.trackingUnsubscribe = this.tracking.onStateChange((s) => {
        this.status.setTracking(s);
      });
      this.status.setTracking(this.tracking.getState());

      // Hide start screen, reveal HUD/status, start the loop.
      this.startScreen.hide();
      this.setOverlaysVisible(true);
      this.started = true;
      this.startAnimation();

      this.startScreen.setStatus('Tracking active');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Release the camera again: a half-started session would keep the
      // camera busy and block the retry.
      try {
        this.tracking.stop();
        this.cameraSource.stop();
        this.disposeVideoBackground();
      } catch {
        // Best effort.
      }
      this.startScreen.setStatus(`AR start failed: ${message}`);
      this.startScreen.setButtonEnabled(true);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Explain why tracking cannot run, or null when it can. Only the real
   * sensor provider reports this; injected providers are trusted as-is.
   */
  private describeTrackingIssue(): string | null {
    const provider = this.tracking as unknown as { getPermissionState?: () => string };
    if (typeof provider.getPermissionState !== 'function') {
      return null;
    }
    let permission: string;
    try {
      permission = provider.getPermissionState();
    } catch {
      return null;
    }
    if (permission === 'unsupported') {
      return 'no motion sensors on this device/browser - open the page on a phone';
    }
    if (permission === 'denied') {
      return 'motion & orientation access denied - allow it in the browser settings and try again';
    }
    return null;
  }

  /**
   * Build the camera-feed background: a screen-filling quad drawn with an
   * orthographic camera before the AR scene.
   *
   * This replaces the old world-space plane, which sat at z = -10 and
   * therefore (a) only covered part of the viewport and (b) slid out of
   * frame as soon as tracking moved the virtual camera.
   *
   * Falls back to "no background" (the game still runs) when video/THREE is
   * unavailable, and never throws.
   */
  private setupVideoBackground(video: HTMLVideoElement): void {
    try {
      if (isTestEnv()) {
        return;
      }
      this.disposeVideoBackground();

      this.videoTexture = new THREE.VideoTexture(video);
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.magFilter = THREE.LinearFilter;
      this.videoTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.videoTexture.wrapT = THREE.ClampToEdgeWrapping;
      this.videoTexture.colorSpace = THREE.SRGBColorSpace;

      const geometry = new THREE.PlaneGeometry(2, 2);
      const material = new THREE.MeshBasicMaterial({
        map: this.videoTexture,
        depthTest: false,
        depthWrite: false,
      });
      this.bgMesh = new THREE.Mesh(geometry, material);
      this.bgMesh.frustumCulled = false;
      this.bgScene?.add(this.bgMesh);

      this.refreshVideoSize(video);
      this.updateBackgroundFit();
      this.updateCameraProjection();
    } catch {
      this.disposeVideoBackground();
    }
  }

  /** Current stream dimensions, or the portrait fallback before they arrive. */
  private getVideoSize(): { width: number; height: number } {
    if (this.videoWidth > 0 && this.videoHeight > 0) {
      return { width: this.videoWidth, height: this.videoHeight };
    }
    return { width: FALLBACK_VIDEO_WIDTH, height: FALLBACK_VIDEO_HEIGHT };
  }

  /**
   * Pick up the stream dimensions once they are known (they are 0 until the
   * first frame decodes) and re-fit FOV + background when they change.
   */
  private refreshVideoSize(video: HTMLVideoElement): void {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h || (w === this.videoWidth && h === this.videoHeight)) {
      return;
    }
    this.videoWidth = w;
    this.videoHeight = h;
    this.updateBackgroundFit();
    this.updateCameraProjection();
  }

  /**
   * Match the virtual camera's field of view to the physical one.
   *
   * `sensorFovDeg` describes the long side of the camera frame. The frame is
   * then "cover"-fitted to the viewport, so whichever axis gets cropped is
   * what the user actually sees - that visible part is the FOV we render
   * with. Getting this wrong is what made the AR view feel zoomed in.
   */
  private updateCameraProjection(): void {
    try {
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      const screenAspect = width / height;
      const { width: vw, height: vh } = this.getVideoSize();

      const tanHalfLong = Math.tan((this.sensorFovDeg * Math.PI) / 360);
      const shortOverLong = Math.min(vw, vh) / Math.max(vw, vh);
      const tanHalfH = vw >= vh ? tanHalfLong : tanHalfLong * shortOverLong;
      const tanHalfV = vh >= vw ? tanHalfLong : tanHalfLong * shortOverLong;

      const visibleTanHalfV = Math.min(tanHalfV, tanHalfH / screenAspect);
      this.camera.fov = clampFov((2 * Math.atan(visibleTanHalfV) * 180) / Math.PI);
      this.camera.aspect = screenAspect;
      this.camera.updateProjectionMatrix();
    } catch {
      // A bad projection update must never break the frame.
    }
  }

  /**
   * "Cover"-fit the camera feed to the viewport by cropping the texture
   * instead of scaling geometry: the quad always spans the whole screen and
   * the image is never letterboxed or squashed.
   */
  private updateBackgroundFit(): void {
    try {
      if (!this.videoTexture) {
        return;
      }
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      const screenAspect = width / height;
      const { width: vw, height: vh } = this.getVideoSize();
      const videoAspect = vw / vh;
      if (!Number.isFinite(videoAspect) || videoAspect <= 0) {
        return;
      }
      if (screenAspect > videoAspect) {
        // Screen wider than the frame: use the full width, crop top/bottom.
        const repeatY = videoAspect / screenAspect;
        this.videoTexture.repeat.set(1, repeatY);
        this.videoTexture.offset.set(0, (1 - repeatY) / 2);
      } else {
        // Screen taller than the frame: use the full height, crop the sides.
        const repeatX = screenAspect / videoAspect;
        this.videoTexture.repeat.set(repeatX, 1);
        this.videoTexture.offset.set((1 - repeatX) / 2, 0);
      }
    } catch {
      // Ignore: the background simply keeps its previous fit.
    }
  }

  /** Tear down the background quad and its texture. Idempotent. */
  private disposeVideoBackground(): void {
    try {
      if (this.bgMesh) {
        this.bgScene?.remove(this.bgMesh);
        const geometry = this.bgMesh.geometry;
        if (geometry && typeof geometry.dispose === 'function') {
          geometry.dispose();
        }
        const material = this.bgMesh.material;
        const materials = Array.isArray(material) ? material : [material];
        for (const m of materials) {
          if (m && typeof m.dispose === 'function') {
            m.dispose();
          }
        }
      }
      if (this.videoTexture) {
        this.videoTexture.dispose();
      }
    } catch {
      // Teardown is best effort.
    }
    this.bgMesh = null;
    this.videoTexture = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
  }

  /**
   * Stop the camera and tear down the running session (keeps DOM for restart).
   */
  stopCamera(): void {
    this.started = false;
    this.starting = false;
    this.wasPlayingOnHide = false;

    // Stop animation
    this.stopAnimation();

    // Stop tracking
    this.tracking.stop();
    if (this.trackingUnsubscribe) {
      this.trackingUnsubscribe();
      this.trackingUnsubscribe = null;
    }

    this.cameraSource.stop();

    // Remove the camera-feed background and its texture.
    this.disposeVideoBackground();

    // Hide overlays
    this.setOverlaysVisible(false);

    // Show start screen
    this.startScreen.show();
    this.startScreen.setStatus('Camera stopped');
    this.startScreen.setButtonEnabled(true);
  }

  /**
   * Start the animation loop
   */
  private startAnimation(): void {
    this.stopAnimation();
    this.lastFrameMs = performance.now();
    this.animate();
  }

  /**
   * Animation loop: video feed + tracking pose -> camera + game visuals.
   * Never throws: a single bad frame must not kill the rAF loop.
   */
  private animate(): void {
    this.animationFrameId = requestAnimationFrame(() => this.animate());

    const now = performance.now();
    const dt = this.lastFrameMs > 0 ? Math.min((now - this.lastFrameMs) / 1000, 0.5) : 1 / 60;
    this.lastFrameMs = now;
    this.elapsedSec += dt;

    // Update video texture if available
    if (this.videoTexture) {
      this.videoTexture.needsUpdate = true;
      try {
        if (this.cameraSource.isStreaming()) {
          this.refreshVideoSize(this.cameraSource.getVideoElement());
        }
      } catch {
        // Keep the last known stream size.
      }
    }

    try {
      const pose = this.tracking.getPose();
      if (pose) {
        this.applyPoseToCamera(pose);
      }
      this.status.setTracking(this.tracking.getState(), this.buildTrackingInfo(pose));
      this.coin.update?.(dt, this.elapsedSec);
      this.beacon.update?.(dt, this.elapsedSec);
      this.game.update(dt);
      this.metrics.recordFrame(pose);
    } catch {
      // Swallow per-frame errors to keep the loop alive.
    }

    this.renderFrame();
  }

  /**
   * Two-pass render: camera feed in screen space, then the AR scene on top
   * with a cleared depth buffer so the feed never occludes the coin.
   */
  private renderFrame(): void {
    try {
      this.renderer.clear();
      if (this.bgScene !== null && this.bgCamera !== null && this.bgMesh !== null) {
        this.renderer.render(this.bgScene, this.bgCamera);
        this.renderer.clearDepth();
      }
      this.renderer.render(this.scene, this.camera);
    } catch {
      // A failed frame must not kill the loop.
    }
  }

  private applyPoseToCamera(pose: CameraPose): void {
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.camera.quaternion.set(
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w
    );
  }

  private buildTrackingInfo(pose: CameraPose | null): {
    fps?: number;
    featureCount?: number;
    position?: { x: number; y: number; z: number };
  } {
    const info: {
      fps?: number;
      featureCount?: number;
      position?: { x: number; y: number; z: number };
    } = {};
    const t = this.tracking as unknown as {
      getFps?: () => number;
      getFeatureCount?: () => number;
    };
    try {
      if (typeof t.getFps === 'function') {
        const fps = t.getFps();
        if (typeof fps === 'number' && Number.isFinite(fps)) {
          info.fps = fps;
        }
      }
      if (typeof t.getFeatureCount === 'function') {
        const featureCount = t.getFeatureCount();
        if (typeof featureCount === 'number' && Number.isFinite(featureCount)) {
          info.featureCount = featureCount;
        }
      }
    } catch {
      // Optional provider stats must never break the frame.
    }
    if (pose) {
      info.position = { x: pose.position.x, y: pose.position.y, z: pose.position.z };
    }
    return info;
  }

  private setOverlaysVisible(visible: boolean): void {
    const display = visible ? 'flex' : 'none';
    if (this.hud.element) {
      this.hud.element.style.display = display;
    }
    if (this.status.element) {
      this.status.element.style.display = display;
    }
  }

  /**
   * Stop the animation loop
   */
  private stopAnimation(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
  }

  /**
   * Handle window resize / orientation change.
   */
  private onResize(): void {
    try {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    } catch {
      // Ignore: the projection update below still keeps the view sane.
    }
    this.updateCameraProjection();
    this.updateBackgroundFit();
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    if (this.orientationResizeTimer !== null) {
      clearTimeout(this.orientationResizeTimer);
      this.orientationResizeTimer = null;
    }
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleOrientationChange);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);

    this.stopCamera();
    this.stopAnimation();

    try {
      this.game.dispose?.();
    } catch {
      // Ignore teardown failures.
    }
    try {
      this.coin.dispose?.();
    } catch {
      // Ignore teardown failures.
    }
    try {
      this.beacon.dispose?.();
    } catch {
      // Ignore teardown failures.
    }

    // Clean up Three.js
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }

    // Clean up UI
    this.hud.destroy?.();
    this.status.destroy?.();
    this.startScreen.destroy();
  }
}
