/**
 * Regression tests for the "nothing is ever drawn" bug.
 *
 * `src/setupTests.ts` mocks `three` globally with bare `jest.fn()`s, so every
 * other test in this suite exercises the headless stub path only. That is how
 * a geometry guard of `'position' in geometry` survived: it is false for a REAL
 * `BufferGeometry` (vertex data lives at `attributes.position`), so on a real
 * browser `createProceduralMesh` returned `null`, `upgradeVisual` bailed, and
 * the scene stayed empty (`renderer.info.render.calls === 0`).
 *
 * This file unmocks `three` so `Coin`/`Beacon` (which load it through a runtime
 * `await import('three')`) get the real library, and asserts that a real
 * `THREE.Mesh` actually reaches `scene.add`.
 */

jest.unmock('three');

import * as THREE from 'three';
import { Beacon } from './Beacon';
import { Coin } from './Coin';

interface StubScene {
  add: (object: unknown) => void;
  remove: (object: unknown) => void;
  added: unknown[];
  removed: unknown[];
}

function makeScene(): StubScene {
  const scene: StubScene = {
    added: [],
    removed: [],
    add: (object: unknown) => {
      scene.added.push(object);
    },
    remove: (object: unknown) => {
      scene.removed.push(object);
    },
  };
  return scene;
}

/** Let the lazy `import('three')` chain in `upgradeVisual` settle. */
async function waitForAdd(scene: StubScene): Promise<void> {
  for (let i = 0; i < 50 && scene.added.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('real three.js (global mock disabled)', () => {
  describe('sanity: this file really gets the unmocked library', () => {
    it('builds a genuine BufferGeometry, which has no `position` property', () => {
      const geometry = new THREE.CylinderGeometry(0.25, 0.25, 0.05, 32);
      // The exact shape the old guard got wrong.
      expect('position' in geometry).toBe(false);
      expect(geometry.attributes.position.count).toBeGreaterThan(0);
      expect(typeof geometry.dispose).toBe('function');
      geometry.dispose();
    });

    it('serves the same real module to the runtime `await import("three")`', async () => {
      const runtime = await import('three');
      expect(typeof runtime.CylinderGeometry.prototype.dispose).toBe('function');
      expect(typeof runtime.MeshStandardMaterial.prototype.dispose).toBe('function');
      expect(new runtime.Mesh()).toBeInstanceOf(THREE.Object3D);
    });
  });

  describe('Coin', () => {
    it('adds a real Mesh to the scene at the spawn point', async () => {
      const scene = makeScene();
      const coin = new Coin(scene, { radius: 0.25, height: 0.05 });
      coin.spawn({ x: 1, y: 1.4, z: -2.5 });
      await waitForAdd(scene);

      expect(scene.added).toHaveLength(1);
      const mesh = scene.added[0] as THREE.Mesh;
      expect(mesh).toBeInstanceOf(THREE.Mesh);
      expect(mesh).toBeInstanceOf(THREE.Object3D);
      expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
      expect(mesh.material).toBeInstanceOf(THREE.Material);
      expect(mesh.position.toArray()).toEqual([1, 1.4, -2.5]);
      // The logical anchor is unaffected by any visual offset.
      expect(coin.getPosition()).toEqual({ x: 1, y: 1.4, z: -2.5 });

      coin.dispose();
    });

    it('bobs the mesh without moving the logical anchor', async () => {
      const scene = makeScene();
      const coin = new Coin(scene, { bobAmp: 0.5, bobFreq: 1 });
      coin.spawn({ x: 0, y: 1, z: -2 });
      await waitForAdd(scene);
      const mesh = scene.added[0] as THREE.Mesh;

      coin.update(0.016, Math.PI / 2);
      expect(mesh.position.y).toBeCloseTo(1.5, 5);
      expect(mesh.position.x).toBe(0);
      expect(mesh.position.z).toBe(-2);
      expect(coin.getPosition()).toEqual({ x: 0, y: 1, z: -2 });

      coin.dispose();
    });

    it('removes the real mesh on dispose, idempotently', async () => {
      const scene = makeScene();
      const coin = new Coin(scene);
      coin.spawn({ x: 0, y: 1, z: -2 });
      await waitForAdd(scene);
      const mesh = scene.added[0];

      expect(() => {
        coin.dispose();
        coin.dispose();
      }).not.toThrow();
      expect(scene.removed).toEqual([mesh]);
    });
  });

  describe('Beacon', () => {
    it('adds a real Mesh to the scene, centred above the attach point', async () => {
      const scene = makeScene();
      const beacon = new Beacon(scene, { height: 4, radius: 0.25 });
      beacon.attachTo({ x: 1, y: 2, z: 3 });
      await waitForAdd(scene);

      expect(scene.added).toHaveLength(1);
      const mesh = scene.added[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      expect(mesh).toBeInstanceOf(THREE.Mesh);
      expect(mesh).toBeInstanceOf(THREE.Object3D);
      expect(mesh.geometry.attributes.position.count).toBeGreaterThan(0);
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(mesh.material.transparent).toBe(true);
      // Beam of height 4 stands on y = 2, so its centre sits at y = 4.
      expect(mesh.position.toArray()).toEqual([1, 4, 3]);
      expect(mesh.visible).toBe(true);
      expect(beacon.getPosition()).toEqual({ x: 1, y: 2, z: 3 });

      beacon.dispose();
    });

    it('pulses the real material opacity and honours setVisible', async () => {
      const scene = makeScene();
      const beacon = new Beacon(scene, { opacity: 0.4 });
      beacon.attachTo({ x: 0, y: 0, z: 0 });
      await waitForAdd(scene);
      const mesh = scene.added[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

      // pulse = opacity * (0.75 + 0.25 * sin(elapsed * 2)); sin peaks at elapsed = pi/4.
      beacon.update(0.016, Math.PI / 4);
      expect(mesh.material.opacity).toBeCloseTo(0.4, 5);
      beacon.update(0.016, (3 * Math.PI) / 4);
      expect(mesh.material.opacity).toBeCloseTo(0.2, 5);

      beacon.setVisible(false);
      beacon.update(0.016, 1.0);
      expect(mesh.visible).toBe(false);
      expect(beacon.isVisible()).toBe(false);

      beacon.dispose();
    });

    it('removes the real mesh on dispose, idempotently', async () => {
      const scene = makeScene();
      const beacon = new Beacon(scene);
      beacon.attachTo({ x: 0, y: 1, z: 0 });
      await waitForAdd(scene);
      const mesh = scene.added[0];

      expect(() => {
        beacon.dispose();
        beacon.dispose();
      }).not.toThrow();
      expect(scene.removed).toEqual([mesh]);
    });
  });

  describe('scene without an `add` method', () => {
    it('keeps the headless stub and never throws', async () => {
      const coin = new Coin({});
      const beacon = new Beacon({});
      expect(() => {
        coin.spawn({ x: 1, y: 2, z: 3 });
        beacon.attachTo({ x: 1, y: 2, z: 3 });
      }).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(coin.getPosition()).toEqual({ x: 1, y: 2, z: 3 });
      expect(beacon.getPosition()).toEqual({ x: 1, y: 2, z: 3 });
      expect(coin.collect()).toBe(true);
      expect(() => {
        coin.dispose();
        beacon.dispose();
      }).not.toThrow();
    });
  });
});
