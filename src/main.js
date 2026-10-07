'use strict';

const { app, BrowserWindow, ipcMain, dialog, Notification, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const pty = require('@lydell/node-pty');

// A separate ID keeps the dev copy apart from the installed app in Start and on the taskbar.
app.setAppUserModelId(app.isPackaged ? 'dev.patrick.manifold' : 'dev.patrick.manifold.dev');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const DATA_DIR = app.getPath('userData');
const WORKSPACE_FILE = path.join(DATA_DIR, 'workspace.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HOOKS_DIR = path.join(DATA_DIR, 'hooks');
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

const DEFAULT_PRESETS = [
  { id: 'fresh', name: 'New conversation', args: [] },
  { id: 'continue', name: 'Continue last conversation in this folder', args: ['--continue'] },
  { id: 'start-dev', name: 'Start dev (/start-dev)', args: [], prompt: '/start-dev' },
  { id: 'start-triage', name: 'Start triage (/start-triage)', args: [], prompt: '/start-triage' },
];

const DEFAULT_SETTINGS = {
  fontSize: 13,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  lineHeight: 1.15,
};

// Claude Code hook event -> session status shown in the sidebar.
const HOOK_STATUS = {
  SessionStart: 'ready',
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  Notification: 'needs',
  Stop: 'ready',
  SessionEnd: 'shell',
};

let win = null;
let hookPort = 0;
let workspace = { sessions: [], activeId: null, bounds: null };

const ptys = new Map();          // session id -> pty process
const runtime = new Map();       // session id -> { status, detail, since }
const lastNotified = new Map();  // session id -> timestamp
const liveNotifications = new Set(); // keep references so click handlers survive GC

// ---------- persistence ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readSettingsFile() {
  if (!fs.existsSync(SETTINGS_FILE)) writeJsonAtomic(SETTINGS_FILE, { ...DEFAULT_SETTINGS, presets: DEFAULT_PRESETS });
  return readJson(SETTINGS_FILE, {}) || {};
}

function loadPresets() {
  const raw = readSettingsFile().presets;
  const valid = Array.isArray(raw)
    ? raw.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
        .map((p) => ({
          id: p.id,
          name: p.name,
          args: Array.isArray(p.args) ? p.args.filter((a) => typeof a === 'string') : [],
          prompt: typeof p.prompt === 'string' && p.prompt ? p.prompt : undefined,
        }))
    : [];
  return valid.length ? valid : DEFAULT_PRESETS;
}

function loadSettings() {
  const raw = readSettingsFile();
  const inRange = (v, min, max) => typeof v === 'number' && v >= min && v <= max;
  return {
    fontSize: inRange(raw.fontSize, 6, 72) ? raw.fontSize : DEFAULT_SETTINGS.fontSize,
    fontFamily: typeof raw.fontFamily === 'string' && raw.fontFamily.trim() ? raw.fontFamily : DEFAULT_SETTINGS.fontFamily,
    lineHeight: inRange(raw.lineHeight, 1, 3) ? raw.lineHeight : DEFAULT_SETTINGS.lineHeight,
  };
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}
function saveNow() {
  clearTimeout(saveTimer);
  try {
    writeJsonAtomic(WORKSPACE_FILE, workspace);
  } catch (err) {
    console.error('Could not save workspace:', err);
  }
}

const findSession = (id) => workspace.sessions.find((s) => s.id === id);

// ---------- status ----------

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function setStatus(id, status, detail = null) {
  const state = { status, detail, since: Date.now() };
  runtime.set(id, state);
  send('session:status', id, state);
}

function publicSession(s) {
  return { ...s, ...(runtime.get(s.id) || { status: 'stopped', detail: null, since: Date.now() }) };
}

function focusSession(id) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  send('session:activate', id);
}

function notifyAttention(s, body) {
  const lookingAtIt = win && win.isFocused() && workspace.activeId === s.id;
  if (lookingAtIt) return;

  const last = lastNotified.get(s.id) || 0;
  if (Date.now() - last < 5000) return;
  lastNotified.set(s.id, Date.now());

  if (Notification.isSupported()) {
    const n = new Notification({ title: s.name, body });
    liveNotifications.add(n);
    const release = () => liveNotifications.delete(n);
    n.on('click', () => { release(); focusSession(s.id); });
    n.on('close', release);
    n.show();
  }
  if (win && !win.isFocused()) win.flashFrame(true);
}

// ---------- Claude Code hooks ----------
// Each session gets its own settings file passed via `claude --settings`,
// so your global ~/.claude/settings.json is never touched. The hooks post
// the event payload to a local listener with the session id in the URL.

function hookSettingsPath(id) {
  return path.join(HOOKS_DIR, `${id}.json`);
}

function writeHookSettings(id) {
  const hooks = {};
  for (const event of Object.keys(HOOK_STATUS)) {
    const url = `http://127.0.0.1:${hookPort}/hook/${HOOK_TOKEN}/${event}/${id}`;
    const command = `curl.exe -s -m 3 -X POST -H "Content-Type: application/json" --data-binary "@-" ${url}`;
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
    hooks[event] = [event === 'PostToolUse' ? { matcher: '*', ...entry } : entry];
  }
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  writeJsonAtomic(hookSettingsPath(id), { hooks });
  return hookSettingsPath(id);
}

function handleHook(event, id, payload) {
  const s = findSession(id);
  if (!s) return;

  if (typeof payload.session_id === 'string' && payload.session_id !== s.claudeSessionId) {
    s.claudeSessionId = payload.session_id; // lets restore use --resume <id>
    scheduleSave();
  }

  const status = HOOK_STATUS[event];
  if (!status) return;

  const message = typeof payload.message === 'string' ? payload.message : '';
  const current = runtime.get(id)?.status;

  // Claude sends an idle reminder a minute after a finished turn. The session
  // is already marked "Your turn", so don't escalate it to "Needs you".
  if (event === 'Notification' && current === 'ready' && /waiting for your input/i.test(message)) return;

  setStatus(id, status, event === 'Notification' ? message : null);

  if (status === 'needs') notifyAttention(s, message || 'Claude needs your approval to continue.');
  else if (event === 'Stop') notifyAttention(s, 'Finished. Ready for your next prompt.');
}

function startHookServer() {
  return new Promise((resolve, reject) => {
    const route = new RegExp(`^/hook/${HOOK_TOKEN}/([A-Za-z]+)/([0-9a-f-]{36})$`);
    const server = http.createServer((req, res) => {
      const match = route.exec(req.url || '');
      if (req.method !== 'POST' || !match) {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => {
        res.writeHead(204).end();
        let payload = {};
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch { /* ignore malformed payloads */ }
        handleHook(match[1], match[2], payload);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// ---------- terminals ----------

const psQuote = (arg) => `'${String(arg).replace(/'/g, "''")}'`;

function startSession(id, cols, rows, resume) {
  const s = findSession(id);
  if (!s) return { ok: false, error: 'That session no longer exists.' };
  if (ptys.has(id)) return { ok: true };

  if (!fs.existsSync(s.cwd)) {
    const error = `Folder not found: ${s.cwd}`;
    setStatus(id, 'exited', error);
    return { ok: false, error };
  }

  const args = ['--settings', writeHookSettings(id)];
  if (resume) {
    if (s.claudeSessionId) args.push('--resume', s.claudeSessionId);
    else args.push('--continue');
  } else {
    const preset = loadPresets().find((p) => p.id === s.presetId);
    if (preset) {
      args.push(...preset.args);
      if (preset.prompt) args.push(preset.prompt);
    }
  }

  // -NoExit keeps PowerShell open if Claude exits, so you can rerun it by hand.
  const command = `& claude ${args.map(psQuote).join(' ')}`;

  let proc;
  try {
    proc = pty.spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', command], {
      name: 'xterm-256color',
      cols: Math.max(cols | 0, 20),
      rows: Math.max(rows | 0, 5),
      cwd: s.cwd,
      env: { ...process.env, MANIFOLD_SESSION_ID: id },
    });
  } catch (err) {
    setStatus(id, 'exited', err.message);
    return { ok: false, error: err.message };
  }

  ptys.set(id, proc);
  setStatus(id, 'starting');

  proc.onData((data) => send('pty:data', id, data));
  proc.onExit(({ exitCode }) => {
    if (ptys.get(id) !== proc) return;
    ptys.delete(id);
    setStatus(id, 'exited', `Shell closed (exit code ${exitCode}).`);
  });

  return { ok: true };
}

function stopSession(id) {
  const proc = ptys.get(id);
  if (!proc) return;
  ptys.delete(id);
  try { proc.kill(); } catch { /* already gone */ }
}

// ---------- IPC ----------

ipcMain.handle('app:init', () => ({
  sessions: workspace.sessions.map(publicSession),
  activeId: workspace.activeId,
  presets: loadPresets(),
  settings: loadSettings(),
}));

ipcMain.handle('presets:list', () => loadPresets());
ipcMain.handle('settings:edit', () => {
  readSettingsFile(); // ensures the file exists
  return shell.openPath(SETTINGS_FILE);
});

ipcMain.handle('dialog:pickFolder', async (_e, defaultPath) => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a project folder',
    properties: ['openDirectory'],
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('session:create', (_e, { cwd, name, presetId } = {}) => {
  if (typeof cwd !== 'string' || !cwd.trim() || !fs.existsSync(cwd.trim())) {
    return { ok: false, error: 'Choose a project folder that exists.' };
  }
  const folder = path.resolve(cwd.trim());
  const s = {
    id: crypto.randomUUID(),
    name: (typeof name === 'string' && name.trim()) || path.basename(folder) || folder,
    cwd: folder,
    presetId: typeof presetId === 'string' ? presetId : 'fresh',
    claudeSessionId: null,
    createdAt: Date.now(),
  };
  workspace.sessions.push(s);
  runtime.set(s.id, { status: 'stopped', detail: null, since: Date.now() });
  saveNow();
  return { ok: true, session: publicSession(s) };
});

ipcMain.handle('session:start', (_e, { id, cols, rows, resume }) => startSession(id, cols, rows, !!resume));

ipcMain.handle('session:restart', (_e, { id, cols, rows }) => {
  stopSession(id);
  return startSession(id, cols, rows, true);
});

ipcMain.handle('session:close', (_e, id) => {
  stopSession(id);
  workspace.sessions = workspace.sessions.filter((s) => s.id !== id);
  runtime.delete(id);
  lastNotified.delete(id);
  if (workspace.activeId === id) workspace.activeId = null;
  try { fs.rmSync(hookSettingsPath(id), { force: true }); } catch { /* ignore */ }
  saveNow();
  return true;
});

ipcMain.handle('session:rename', (_e, { id, name }) => {
  const s = findSession(id);
  if (s && typeof name === 'string' && name.trim()) {
    s.name = name.trim();
    scheduleSave();
  }
  return s ? publicSession(s) : null;
});

ipcMain.on('session:focus', (_e, id) => {
  workspace.activeId = id;
  scheduleSave();
});

ipcMain.on('pty:write', (_e, id, data) => {
  ptys.get(id)?.write(data);
});

ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  const proc = ptys.get(id);
  if (proc && cols > 0 && rows > 0) {
    try { proc.resize(cols, rows); } catch { /* pty closing */ }
  }
});

ipcMain.handle('clipboard:read', async () => ({
  text: await clipboard.readText(),
  hasImage: await clipboard.has('image/png'),
}));
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

// ---------- window ----------

function createWindow() {
  const b = workspace.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1400,
    height: b.height || 900,
    x: b.x,
    y: b.y,
    minWidth: 820,
    minHeight: 480,
    title: 'Manifold',
    backgroundColor: '#1a212c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('focus', () => win.flashFrame(false));
  win.on('close', () => {
    workspace.bounds = win.getBounds();
    saveNow();
  });
  win.on('closed', () => { win = null; });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const saved = readJson(WORKSPACE_FILE, {});
  workspace = {
    sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
    activeId: saved.activeId || null,
    bounds: saved.bounds || null,
  };
  for (const s of workspace.sessions) runtime.set(s.id, { status: 'stopped', detail: null, since: Date.now() });

  hookPort = await startHookServer();
  loadSettings();
  fs.watchFile(SETTINGS_FILE, { interval: 1000 }, () => send('settings:changed', loadSettings()));
  createWindow();
});

app.on('before-quit', () => {
  saveNow();
  for (const id of [...ptys.keys()]) stopSession(id);
});

app.on('window-all-closed', () => app.quit());
