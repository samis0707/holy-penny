import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

// Get base path from environment or use default
// For GitHub Pages, BASE_PATH is set by the deployment workflow
const basePath = process.env.BASE_PATH || '/holy-penny/';

/**
 * Local HTTPS is only enabled when a certificate pair is actually present.
 * getUserMedia + the motion sensors require a secure context on real devices,
 * so `npm run cert` (mkcert) is the recommended local setup - but a missing
 * certificate must not crash `npm run dev`.
 */
const keyPath = path.resolve(__dirname, './localhost-key.pem');
const certPath = path.resolve(__dirname, './localhost-cert.pem');
const hasLocalCert = fs.existsSync(keyPath) && fs.existsSync(certPath);

export default defineConfig({
  base: basePath,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 3000,
    open: true,
    // Listen on the LAN so a phone can open the dev server for AR testing.
    host: true,
    ...(hasLocalCert
      ? {
          https: {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
          },
        }
      : {}),
  },
});
