/**
 * Main entry point for Holy Penny WebAR Game
 * Wires Lanes A-D through the App class.
 */

import { App } from './app/App';
import type { AppOptions } from './app/App';

function isJestEnv(): boolean {
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const proc = g['process'] as { env?: Record<string, unknown> } | undefined;
    return !!proc?.env?.['JEST_WORKER_ID'];
  } catch {
    return false;
  }
}

/**
 * `?fov=70` overrides the assumed long-side field of view of the phone
 * camera. Lens FOV differs per device and can only be judged by holding the
 * phone up, so it is tunable without a rebuild.
 */
export function readOptionsFromLocation(search: string): AppOptions {
  try {
    const raw = new URLSearchParams(search).get('fov');
    if (raw === null) {
      return {};
    }
    const fov = Number.parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(fov) || fov <= 0) {
      return {};
    }
    return { cameraFovDeg: fov };
  } catch {
    return {};
  }
}

// Singleton for the browser only: importing this module under Jest/jsdom
// must stay side-effect free (no renderer, no DOM nodes).
let app: App | undefined;
if (typeof window !== 'undefined' && !isJestEnv()) {
  app = new App(readOptionsFromLocation(window.location.search));
}

export { App, app };
