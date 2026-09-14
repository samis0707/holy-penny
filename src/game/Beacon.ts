/**
 * Beacon - vertical light beam marking the coin position.
 *
 * Same headless-first design as `Coin`:
 * - Works with no scene at all (pure state) so unit tests run in jsdom
 *   under the global `three` mock in `src/setupTests.ts`.
 * - `three` is never imported at the top level; it is loaded via lazy
 *   dynamic `import()` only when a scene object with an `add` method was
 *   provided. Any failure keeps the headless stub. Nothing here ever throws.
 *
 * Invariants:
 * - Hidden until `attachTo` is called.
 * - `update` pulses the beam but never re-shows it after `setVisible(false)`.
 * - `dispose` is idempotent.
 */

export interface BeaconOptions {
  height?: number;
  radius?: number;
  color?: number;
  opacity?: number;
}

export interface BeaconPosition {
  x: number;
  y: number;
  z: number;
}

interface SceneLike {
  add?: (object: unknown) => void;
  remove?: (object: unknown) => void;
}

const DEFAULT_HEIGHT = 3;
const DEFAULT_RADIUS = 0.25;
const DEFAULT_COLOR = 0xffc94d;
const DEFAULT_OPACITY = 0.35;
const PULSE_FREQ = 2.0;

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
 * so that check is false in every real browser and the beam is never built.
 * `dispose()` is on the real `BufferGeometry`/`Material` prototypes and absent
 * from the mock instance, which is exactly the distinction we need here.
 */
function isRealThreeResource(value: unknown): boolean {
  return isObject(value) && typeof (value as { dispose?: unknown }).dispose === 'function';
}

export class Beacon {
  private readonly scene: SceneLike | null;
  private readonly height: number;
  private readonly radius: number;
  private readonly color: number;
  private readonly opacity: number;

  private position: BeaconPosition | null = null;
  private attached = false;
  private visible = false;
  private pulse = DEFAULT_OPACITY;
  private mesh: unknown = null;
  private addedToScene = false;
  private disposed = false;
  private upgradeStarted = false;

  constructor(scene?: unknown, opts?: BeaconOptions) {
    this.scene = isObject(scene) ? (scene as SceneLike) : null;
    this.height = opts?.height ?? DEFAULT_HEIGHT;
    this.radius = opts?.radius ?? DEFAULT_RADIUS;
    this.color = opts?.color ?? DEFAULT_COLOR;
    this.opacity = opts?.opacity ?? DEFAULT_OPACITY;
    this.pulse = this.opacity;
  }

  /** Attach the beam to a world position (copied) and show it. */
  attachTo(position: BeaconPosition): void {
    if (this.disposed) {
      return;
    }
    this.position = { x: position.x, y: position.y, z: position.z };
    this.attached = true;
    this.visible = true;
    this.ensureVisual();
    this.syncVisual();
  }

  /** Advance the pulse animation. Visual only, safe while detached. */
  update(dtSec: number, elapsedSec: number): void {
    if (!Number.isFinite(dtSec) || !Number.isFinite(elapsedSec)) {
      return;
    }
    void dtSec;
    if (!this.attached || this.position === null) {
      return;
    }
    this.pulse = this.opacity * (0.75 + 0.25 * Math.sin(elapsedSec * PULSE_FREQ));
    this.syncVisual();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.syncVisual();
  }

  isVisible(): boolean {
    return this.visible;
  }

  getPosition(): BeaconPosition | null {
    if (this.position === null) {
      return null;
    }
    return { x: this.position.x, y: this.position.y, z: this.position.z };
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
      position: { ...this.position },
      visible: this.visible,
      material: { opacity: this.pulse },
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
      const mesh = this.createBeamMesh(THREE);
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
    } catch {
      // Keep the headless stub.
    }
  }

  private createBeamMesh(THREE: typeof import('three')): unknown {
    try {
      const geometry = new THREE.CylinderGeometry(
        this.radius,
        this.radius,
        this.height,
        16,
        1,
        true
      );
      if (!isRealThreeResource(geometry)) {
        return null;
      }
      const material = new THREE.MeshBasicMaterial({
        color: this.color,
        transparent: true,
        opacity: this.pulse,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      if (!isObject(mesh) || !('position' in mesh)) {
        this.disposeObject({ geometry, material });
        return null;
      }
      return mesh;
    } catch {
      return null;
    }
  }

  private syncVisual(): void {
    try {
      if (!isObject(this.mesh)) {
        return;
      }
      const mesh = this.mesh as {
        position?: {
          x?: number;
          y?: number;
          z?: number;
          set?: (x: number, y: number, z: number) => void;
        };
        material?: unknown;
        visible?: unknown;
      };
      if (this.position !== null && mesh.position !== undefined && mesh.position !== null) {
        const anchorY = this.position.y + this.height / 2;
        if (typeof mesh.position.set === 'function') {
          mesh.position.set(this.position.x, anchorY, this.position.z);
        } else {
          mesh.position.x = this.position.x;
          mesh.position.y = anchorY;
          mesh.position.z = this.position.z;
        }
      }
      const material = mesh.material;
      if (isObject(material) && typeof material['opacity'] === 'number') {
        material['opacity'] = this.pulse;
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
