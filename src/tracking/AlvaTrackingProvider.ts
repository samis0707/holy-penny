/**
 * AlvaTrackingProvider - PLACEHOLDER, not wired into the app.
 *
 * AlvaAR (visual SLAM) is still the goal for 6DoF tracking, but the toolkit
 * is not available as a dependency yet, so this provider reports a STATIC
 * identity pose: the camera never moves and the coin never gets closer.
 * That fake pose is exactly why the app felt like it had no tracking.
 *
 * The app uses `DeviceTrackingProvider` (real gyro/accelerometer tracking)
 * instead. Keep this file as the seam for the real SLAM implementation, but
 * do not use it as the app's provider until it actually produces poses.
 */
import type {
  CameraPose,
  TrackingState,
  TrackingStateListener,
  TrackingProvider,
} from './TrackingProvider';

export interface AlvaTrackingProviderOptions {
  trackingWidth?: number;
  trackingHeight?: number;
  onPose?: (p: CameraPose) => void;
}

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

export class AlvaTrackingProvider implements TrackingProvider {
  private state: TrackingState = 'STOPPED';
  private pose: CameraPose | null = null;
  private listeners = new Set<TrackingStateListener>();
  private video: HTMLVideoElement | null;
  private opts: AlvaTrackingProviderOptions;
  private fps = 0;
  private featureCount = 0;

  constructor(video: HTMLVideoElement | null, opts: AlvaTrackingProviderOptions = {}) {
    this.video = video;
    this.opts = opts;
  }

  private setState(s: TrackingState): void {
    this.state = s;
    for (const cb of this.listeners) {
      cb(s);
    }
  }

  private activateDummy(): void {
    const dummy: CameraPose = {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      timestamp: Date.now(),
      featureCount: 0,
      trackingFps: 0,
    };
    this.pose = dummy;
    this.fps = 0;
    this.featureCount = 0;
    this.setState('ACTIVE');
    if (this.opts.onPose) {
      try {
        this.opts.onPose(copyPose(dummy));
      } catch {
        // ignore listener errors: provider must never throw
      }
    }
  }

  async start(): Promise<void> {
    try {
      if (this.state !== 'STOPPED') {
        return;
      }
      void this.video;
      void this.opts.trackingWidth;
      void this.opts.trackingHeight;
      this.setState('INITIALIZING');
      try {
        const specifier = 'alvaartoolkit';
        const mod = await import(/* @vite-ignore */ specifier);
        void mod;
        if (this.getState() !== 'INITIALIZING') {
          return;
        }
        this.activateDummy();
      } catch {
        if (this.getState() !== 'INITIALIZING') {
          return;
        }
        this.activateDummy();
      }
    } catch {
      try {
        if (this.getState() === 'INITIALIZING') {
          this.activateDummy();
        }
      } catch {
        // never throw from start()
      }
    }
  }

  stop(): void {
    if (this.state === 'STOPPED') {
      return;
    }
    this.pose = null;
    this.fps = 0;
    this.featureCount = 0;
    this.setState('STOPPED');
  }

  getPose(): CameraPose | null {
    if (this.state !== 'ACTIVE') {
      return null;
    }
    if (this.pose === null) {
      return null;
    }
    return copyPose(this.pose);
  }

  getState(): TrackingState {
    return this.state;
  }

  onStateChange(cb: TrackingStateListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getFps(): number {
    return this.fps;
  }

  getFeatureCount(): number {
    return this.featureCount;
  }
}
