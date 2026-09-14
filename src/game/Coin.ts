/**
 * Coin - collectible AR coin with spin + bob animation.
 *
 * Headless-first design:
 * - Works with no scene at all (pure game state) so unit tests run in jsdom
 *   under the global `three` mock in `src/setupTests.ts` (bare jest.fn(),
 *   no Vector3 math).
 * - `three` is never imported at the top level. It is loaded via lazy
 *   dynamic `import()` only when a scene object with an `add` method was
 *   provided. `GLTFLoader` is likewise imported lazily and only then; any
 *   failure keeps the procedural fallback mesh. Nothing here ever throws.
 *
 * Game semantics:
 * - `spawn` is once-only until `reset` (second call is a no-op).
 * - `collect` returns `true` exactly once per placement.
 * - `getPosition` returns the logical anchor; the visual bob offset never
 *   affects it.
 */

export interface CoinOptions {
  radius?: number;
  height?: number;
  spinSpeed?: number;
  bobAmp?: number;
  bobFreq?: number;
  glbUrl?: string;
}

export interface CoinPosition {
  x: number;
  y: number;
  z: number;
}

interface SceneLike {
  add?: (object: unknown) => void;
  remove?: (object: unknown) => void;
}

interface VisualLike {
  position?: {
    x?: number;
    y?: number;
    z?: number;
    set?: (x: number, y: number, z: number) => void;
  };
  rotation?: { y?: number };
  visible?: unknown;
}

const DEFAULT_RADIUS = 0.25;
const DEFAULT_HEIGHT = 0.05;
const DEFAULT_SPIN_SPEED = 2.0;
const DEFAULT_BOB_AMP = 0.05;
const DEFAULT_BOB_FREQ = 2.0;

/**
 * Default model URL, resolved against the app base path at runtime.
 *
 * NOTE: intentionally not a static `import.meta.env.BASE_URL` expression:
 * ts-jest executes tests as CommonJS where `import.meta` is a SyntaxError,
 * so any static occurrence would break the whole suite. `document.baseURI`
 * reflects the Vite base path (`import.meta.env.BASE_URL` at build) in the
 * browser; see `public/models/coin.glb.README.md`.
 */
function defaultGlbUrl(): string {
  try {
    if (typeof document !== 'undefined' && typeof document.baseURI === 'string') {
      return new URL('models/coin.glb', document.baseURI).toString();
    }
  } catch {
    // Fall through to the root-absolute fallback.
  }
  return '/models/coin.glb';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True for a real three.js resource (geometry/material), false for the bare
 * `jest.fn()` mock in `src/setupTests.ts`, where `new THREE.CylinderGeometry()`
 * yields an empty instance with nothing on its prototype.
 *
 * DO NOT "simplify" this to `'position' in geometry`: a real `BufferGeometry`
 * has NO `position` property (the vertex data lives at `attributes.position`),
 * so that check is false in every real browser and the visual is never built.
 * `dispose()` is on the real `BufferGeometry`/`Material` prototypes and absent
 * from the mock instance, which is exactly the distinction we need here.
 */
function isRealThreeResource(value: unknown): boolean {
  return isObject(value) && typeof (value as { dispose?: unknown }).dispose === 'function';
}

export class Coin {
  private readonly scene: SceneLike | null;
  private readonly radius: number;
  private readonly coinHeight: number;
  private readonly spinSpeed: number;
  private readonly bobAmp: number;
  private readonly bobFreq: number;
  private readonly glbUrl: string;

  private placed = false;
  private collected = false;
  private visible = true;
  private basePosition: CoinPosition | null = null;
  private rotationY = 0;
  private visualY = 0;
  private mesh: unknown = null;
  private addedToScene = false;
  private disposed = false;
  private upgradeStarted = false;

  constructor(scene?: unknown, opts?: CoinOptions) {
    this.scene = isObject(scene) ? (scene as SceneLike) : null;
    this.radius = opts?.radius ?? DEFAULT_RADIUS;
    this.coinHeight = opts?.height ?? DEFAULT_HEIGHT;
    this.spinSpeed = opts?.spinSpeed ?? DEFAULT_SPIN_SPEED;
    this.bobAmp = opts?.bobAmp ?? DEFAULT_BOB_AMP;
    this.bobFreq = opts?.bobFreq ?? DEFAULT_BOB_FREQ;
    this.glbUrl = opts?.glbUrl ?? defaultGlbUrl();
  }

  /** Place the coin once; further calls are no-ops until `reset`. */
  spawn(pos: CoinPosition): void {
    if (this.placed || this.disposed) {
      return;
    }
    this.basePosition = { x: pos.x, y: pos.y, z: pos.z };
    this.visualY = pos.y;
    this.placed = true;
    this.collected = false;
    this.ensureVisual();
    this.syncVisual();
  }

  /** Advance spin + bob. Visual only, safe to call before `spawn`. */
  update(dtSec: number, elapsedSec: number): void {
    if (!Number.isFinite(dtSec) || !Number.isFinite(elapsedSec)) {
      return;
    }
    if (!this.placed || this.basePosition === null) {
      return;
    }
    this.rotationY += this.spinSpeed * dtSec;
    this.visualY = this.basePosition.y + Math.sin(elapsedSec * this.bobFreq) * this.bobAmp;
    this.syncVisual();
  }

  /**
   * Collect the coin. Returns `true` exactly once per placement,
   * `false` before spawning or after collection.
   */
  collect(): boolean {
    if (!this.placed || this.collected) {
      return false;
    }
    this.collected = true;
    this.setVisible(false);
    return true;
  }

  reset(): void {
    this.placed = false;
    this.collected = false;
    this.basePosition = null;
    this.rotationY = 0;
    this.setVisible(true);
  }

  isCollected(): boolean {
    return this.collected;
  }

  isPlaced(): boolean {
    return this.placed;
  }

  /** Logical anchor copy (or null); the bob offset never affects it. */
  getPosition(): CoinPosition | null {
    if (this.basePosition === null) {
      return null;
    }
    return { x: this.basePosition.x, y: this.basePosition.y, z: this.basePosition.z };
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.syncVisual();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Release visual resources. Idempotent; safe headless. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachVisual();
  }

  private ensureVisual(): void {
    if (this.mesh !== null || this.upgradeStarted) {
      return;
    }
    // Headless-safe stub: plain data, no three.js needed.
    this.mesh = {
      position: { ...this.basePosition },
      rotation: { y: 0 },
      visible: this.visible,
    };
    if (this.scene === null) {
      return;
    }
    this.upgradeStarted = true;
    void this.upgradeVisual();
  }

  private async upgradeVisual(): Promise<void> {
    try {
      if (this.scene === null || this.disposed) {
        return;
      }
      if (typeof this.scene.add !== 'function') {
        return;
      }
      const THREE = await import('three');
      const mesh = this.createProceduralMesh(THREE);
      if (mesh === null || this.disposed) {
        if (mesh !== null) {
          this.disposeObject(mesh);
        }
        return;
      }
      this.scene.add(mesh);
      this.mesh = mesh;
      this.addedToScene = true;
      this.syncVisual();
      await this.tryLoadGlb();
    } catch {
      // Keep the headless stub / procedural fallback.
    }
  }

  private createProceduralMesh(THREE: typeof import('three')): unknown {
    try {
      const geometry = new THREE.CylinderGeometry(this.radius, this.radius, this.coinHeight, 32);
      if (!isRealThreeResource(geometry)) {
        return null;
      }
      if (typeof (geometry as { rotateX?: unknown }).rotateX === 'function') {
        (geometry as { rotateX: (angle: number) => void }).rotateX(Math.PI / 2);
      }
      const material = new THREE.MeshStandardMaterial({
        color: 0xffc93c,
        metalness: 0.9,
        roughness: 0.25,
      });
      const mesh = new THREE.Mesh(geometry, material);
      if (!isObject(mesh) || !('position' in mesh) || !('rotation' in mesh)) {
        this.disposeObject({ geometry, material });
        return null;
      }
      return mesh;
    } catch {
      return null;
    }
  }

  private async tryLoadGlb(): Promise<void> {
    try {
      if (this.scene === null || this.disposed || this.mesh === null) {
        return;
      }
      if (typeof this.scene.add !== 'function') {
        return;
      }
      const loaderModule = (await import('three/addons/loaders/GLTFLoader.js')) as unknown as {
        GLTFLoader?: new () => { loadAsync?: (url: string) => Promise<unknown> };
      };
      if (typeof loaderModule.GLTFLoader !== 'function') {
        return;
      }
      const loader = new loaderModule.GLTFLoader();
      if (typeof loader.loadAsync !== 'function') {
        return;
      }
      const gltf = (await loader.loadAsync(this.glbUrl)) as unknown;
      if (!isObject(gltf) || !isObject(gltf['scene'])) {
        return;
      }
      if (this.disposed || this.scene === null) {
        return;
      }
      this.detachVisual();
      this.scene.add(gltf['scene']);
      this.mesh = gltf['scene'];
      this.addedToScene = true;
      this.syncVisual();
    } catch {
      // Keep the procedural mesh.
    }
  }

  private syncVisual(): void {
    try {
      if (!isObject(this.mesh)) {
        return;
      }
      const mesh = this.mesh as VisualLike;
      if (this.basePosition !== null && mesh.position !== undefined && mesh.position !== null) {
        if (typeof mesh.position.set === 'function') {
          mesh.position.set(this.basePosition.x, this.visualY, this.basePosition.z);
        } else {
          mesh.position.x = this.basePosition.x;
          mesh.position.y = this.visualY;
          mesh.position.z = this.basePosition.z;
        }
      }
      if (mesh.rotation !== undefined && mesh.rotation !== null) {
        mesh.rotation.y = this.rotationY;
      }
      mesh.visible = this.visible;
    } catch {
      // Visual sync must never break game logic.
    }
  }

  private detachVisual(): void {
    try {
      if (this.addedToScene && this.scene !== null && typeof this.scene.remove === 'function') {
        this.scene.remove(this.mesh);
      }
    } catch {
      // Ignore removal failures.
    }
    try {
      this.disposeObject(this.mesh);
    } catch {
      // Ignore disposal failures.
    }
    this.mesh = null;
    this.addedToScene = false;
  }

  private disposeObject(obj: unknown): void {
    if (!isObject(obj)) {
      return;
    }
    const geometry = obj['geometry'];
    if (isObject(geometry) && typeof geometry['dispose'] === 'function') {
      (geometry['dispose'] as () => void).call(geometry);
    }
    const material = obj['material'];
    const materials = Array.isArray(material) ? material : [material];
    for (const entry of materials) {
      if (isObject(entry) && typeof entry['dispose'] === 'function') {
        (entry['dispose'] as () => void).call(entry);
      }
    }
  }
}
