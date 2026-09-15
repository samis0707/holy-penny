# Holy Penny - WebAR Coin Game

A browser-based augmented reality coin collection game built with TypeScript, Vite, and Three.js.

## Overview

Holy Penny is a WebAR game where users can:
- Scan a QR code or open a URL to start
- Use their phone's camera to view AR content
- Find and collect virtual coins in their environment
- Experience immersive AR gameplay without installing an app

## Development

### Prerequisites

- Node.js 18+ 
- npm 9+
- Git

### Installation

```bash
npm install
```

### Development Server

```bash
npm run dev
```

Opens the development server at `http://localhost:3000` and listens on the LAN
so a phone can reach it.

The camera and the motion sensors both require a **secure context**. `localhost`
counts as secure, but an IP address such as `https://192.168.x.x:3000` does not
unless the server serves HTTPS. Drop a certificate pair next to `package.json`
as `localhost-key.pem` / `localhost-cert.pem` (for example with
[mkcert](https://github.com/FiloSottile/mkcert)) and the dev server picks it up
automatically. Without those files it falls back to plain HTTP instead of
failing to start.

### Build

```bash
npm run build
```

Builds the production-ready files in the `dist/` directory.

### Preview

```bash
npm run preview
```

Previews the built production files locally.

### Lint

```bash
npm run lint
```

Runs ESLint to check for code issues.

```bash
npm run lint:fix
```

Automatically fixes lint issues where possible.

### Format

```bash
npm run format
```

Formats all TypeScript files using Prettier.

## Project Structure

```
.
├── public/                    # Static assets
│   ├── models/               # 3D models
│   ├── sounds/               # Sound files
│   └── textures/             # Texture files
├── src/
│   ├── app/                  # Main application
│   │   └── App.ts
│   ├── tracking/             # AR tracking providers
│   │   ├── TrackingProvider.ts
│   │   ├── CameraSource.ts
│   │   ├── DeviceTrackingProvider.ts   # active provider (device sensors)
│   │   └── AlvaTrackingProvider.ts     # placeholder, not wired up
│   ├── rendering/            # Rendering components
│   │   ├── Renderer.ts
│   │   ├── Scene.ts
│   │   └── Camera.ts
│   ├── game/                 # Game logic
│   │   ├── Game.ts
│   │   ├── Coin.ts
│   │   ├── Beacon.ts
│   │   └── Player.ts
│   ├── ui/                   # User interface
│   │   ├── StartScreen.ts
│   │   ├── HUD.ts
│   │   └── TrackingStatus.ts
│   ├── utils/                # Utility functions
│   ├── main.ts               # Entry point
│   └── vite-env.d.ts         # Vite environment types
├── .github/
│   └── workflows/
│       └── deploy-pages.yml  # GitHub Pages deployment
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## Technology Stack

- **Language**: TypeScript
- **Build Tool**: Vite
- **3D Rendering**: Three.js
- **AR Tracking**: device sensors (gyroscope/accelerometer); AlvaAR SLAM still planned
- **Hosting**: GitHub Pages

## AR Tracking

`DeviceTrackingProvider` is the live provider. It uses the device's own
sensors, so the pose is real:

- **Orientation (3DoF)** from `deviceorientationabsolute` / `deviceorientation`,
  converted to a Three.js camera quaternion with the screen-orientation angle
  applied, so the coin stays put in the room while you look around.
- **Translation** from `devicemotion`: steps are detected as peaks in the
  accelerometer magnitude and move the player forward along the current
  heading (0.7 m per step by default). That is what lets you walk up to the
  coin and collect it. The detector is tuned for a phone held steadily to
  watch the screen (a soft, gradual signal), not just a sharp pocket-swing
  gait: the baseline it compares against adapts slowly (`BASELINE_SMOOTHING`)
  so it cannot chase a gradual rise or a lingering plateau and silently
  swallow the step, which is what made the coin feel uncollectable.
  Collection itself has a generous 1.0 m radius (`Game`'s
  `collectThreshold`), since the tracked position is pure dead reckoning
  from an assumed step length, not a measurement of real distance walked.

On iOS 13+ both sensors need `requestPermission()`, which only works from a
user gesture — hence the START AR button. `App.startAR()` requests tracking
*before* the camera for exactly this reason: `getUserMedia()`'s own camera
prompt is a separate, more lenient permission system, but awaiting it first
consumes the tap's "transient activation" that `requestPermission()` needs.
Ask for the camera first and Safari silently denies the sensors without ever
showing their dialog — it looks like "motion & orientation access denied"
even though the user only ever saw and accepted the camera prompt. If
orientation access is refused or the device has no sensors, the app says so
instead of pretending to track; refused *motion* access is non-fatal and
degrades to look-around-only.

`AlvaTrackingProvider` remains as the seam for real visual SLAM, but it is a
placeholder that reports a static identity pose and is not wired into the app.

### Camera field of view

The camera feed is drawn as a screen-space background pass that always fills
the viewport ("cover" fit, cropped rather than letterboxed).

The 3D camera's field of view is a directly-tunable **horizontal** target
(100° by default), converted to the vertical FOV Three.js actually wants
using the standard rectilinear formula for the current screen aspect ratio.
It is deliberately **not** derived from the physical camera's sensor spec:
an earlier version did that, and on a portrait phone screen the "physically
correct" number collapses to roughly 30° horizontal - a tunnel-vision view
that feels much smaller than what you'd naturally expect from an AR app.
There is no real visual SLAM here to keep pixel-perfectly aligned with
anyway (see the tracking section below), so a comfortably wide, directly
tunable FOV serves the game better than a "physically accurate" one derived
from a guessed sensor spec. Override it with:

```ts
new App({ cameraFovDeg: 110 }); // wider
```

or, without a rebuild, `?fov=110` on the URL. Valid range is 40-150°.

## Deployment

Every push, on any branch, is built and deployed straight to production:

`https://samis0707.github.io/holy-penny/`

There are no preview deployments - the site always shows whatever was pushed
last, from whichever branch.

The deploy job deliberately does not declare the `github-pages` environment:
doing so makes GitHub apply that environment's deployment-branch rule, which
here allows only the default branch, and every other branch is then rejected
before the job starts. To use the environment anyway (it surfaces the deployed
URL on the run), allow all branches under **Settings -> Environments ->
github-pages -> Deployment branches** first.

## Git Workflow

1. Create a feature branch: `git checkout -b feature/<name>-<task>`
2. Make your changes
3. Commit and push: `git push origin feature/<name>-<task>`
4. Create a Pull Request to `main`
5. After merge, delete the feature branch

## License

MIT
