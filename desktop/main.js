/* DevOps Local — Electron desktop wrapper.

   The agent already serves the dashboard same-origin, so the desktop app is a
   thin shell: it (1) picks a workspace on first run, (2) spawns the agent as a
   sidecar on a free loopback port using Electron's bundled Node, (3) waits for
   /api/health, then (4) opens a window pointed at the agent's URL. The agent
   child is killed on quit (mirroring its own SIGINT graceful shutdown).

   No frontend rewrite is required — this loads exactly what `npm start` serves. */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;

// Dev: the agent lives at ../agent. Packaged: it's copied into resources/agent
// (see extraResources in package.json), with the dashboard files one level up so
// the agent's STATIC_ROOT (= agentDir/..) still resolves index.html.
const AGENT_DIR = isDev ? path.join(__dirname, '..', 'agent') : path.join(process.resourcesPath, 'agent');
const AGENT_ENTRY = path.join(AGENT_DIR, 'server.js');
const CONFIG_PATH = path.join(app.getPath('userData'), 'devops-desktop.json');

let agentProc = null;
let agentPort = 0;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}
function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) { /* best effort */ }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port: port, path: '/api/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('agent did not become healthy in time'));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

async function ensureWorkspace() {
  const cfg = readConfig();
  if (cfg.workspaceRoot && fs.existsSync(cfg.workspaceRoot)) return cfg.workspaceRoot;
  const res = await dialog.showOpenDialog({
    title: 'Choose your project folder',
    message: 'DevOps Local inspects one project folder (its workspace root). Pick the project you want to work on — you can change this later.',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
  cfg.workspaceRoot = res.filePaths[0];
  writeConfig(cfg);
  return cfg.workspaceRoot;
}

async function startAgent(workspaceRoot) {
  agentPort = await freePort();
  agentProc = spawn(process.execPath, [AGENT_ENTRY], {
    cwd: AGENT_DIR,
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',                 // run the agent with Electron's bundled Node
      PORT: String(agentPort),
      HOST: '127.0.0.1',
      WORKSPACE_ROOT: workspaceRoot,
      AGENT_STATE_DIR: app.getPath('userData')   // keep all state outside the read-only app bundle
    }),
    stdio: 'inherit'
  });
  agentProc.on('exit', () => { agentProc = null; });
  await waitForHealth(agentPort, 20000);
}

function stopAgent() {
  if (agentProc) {
    try { agentProc.kill('SIGINT'); } catch (e) { /* ignore */ }
    agentProc = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: '#0b0f1a',
    title: 'DevOps Local',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.once('ready-to-show', () => win.show());
  // Open external links in the system browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL('http://127.0.0.1:' + agentPort + '/');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

if (process.platform === 'win32') app.setAppUserModelId('com.mochifoxgames.devopslocal');

// Single-instance: focus the existing window instead of spawning a second agent.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(async () => {
    if (!isDev) Menu.setApplicationMenu(null);
    const ws = await ensureWorkspace();
    if (!ws) { app.quit(); return; }
    try {
      await startAgent(ws);
      createWindow();
    } catch (e) {
      dialog.showErrorBox('DevOps Local', 'The local agent failed to start:\n\n' + e.message);
      app.quit();
      return;
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopAgent);
app.on('will-quit', stopAgent);
process.on('exit', stopAgent);
