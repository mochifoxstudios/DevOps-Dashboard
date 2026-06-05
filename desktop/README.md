# DevOps Local — Desktop (Electron)

A thin Electron shell that packages the dashboard **and** the local agent into one
installable desktop app. There's no frontend rewrite: the agent already serves the
dashboard same-origin, so this wrapper just runs the agent as a sidecar and points
a window at it.

## What it does on launch

1. **First run:** prompts you to pick a **workspace folder** (the single project the
   agent inspects). The choice is saved to `devops-desktop.json` in the app's
   per-user data directory.
2. Spawns the agent on a **free loopback port** using Electron's bundled Node
   (`ELECTRON_RUN_AS_NODE`), with `HOST=127.0.0.1`, `WORKSPACE_ROOT=<your folder>`,
   and `AGENT_STATE_DIR=<userData>` (so all state — keystore, brain state, audit
   log — lives outside the read-only app bundle; this is exactly why V1.00.1 added
   the `AGENT_STATE_DIR` indirection).
3. Waits for `/api/health`, then opens the window at the agent's URL.
4. On quit, sends `SIGINT` to the agent so its sentinels shut down cleanly.

## Develop

```sh
cd desktop
npm install
npm start          # launches Electron; the agent runs from ../agent
```

## Build installers

```sh
npm run build:win     # NSIS installer + portable .exe (dist/)
npm run build:mac     # dmg
npm run build:linux   # AppImage
```

`electron-builder` bundles `../agent` (minus secrets, tests, and fixtures) and the
dashboard static files into the app's `resources/`. The agent's `node_modules` ship
with it, so end users need **no Node install**.

## Not done yet (tracked for follow-up)

- **App icons** — add `build/icon.{ico,icns,png}` (the Mochi Library setup has a
  `generate-icons.js` + `sharp` pipeline to reuse). Until then electron-builder uses
  its default icon.
- **Code signing + auto-update** — Windows Azure Trusted Signing + `electron-updater`
  (removes the SmartScreen "unknown publisher" warning). Needs Azure enrollment lead
  time; start that out-of-band.
- **CI build job** — a GitHub Actions matrix that produces unsigned installers on
  tags, reusing the `Setups/Mochi Library Setup/.github/workflows/build.yml` shape.
- **Verify on each OS** — the sidecar lifecycle is validated in isolation, but the
  packaged app should be smoke-tested per platform.
