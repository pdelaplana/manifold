'use strict';

const api = window.sessions;
const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  stopped: 'Not started',
  starting: 'Starting',
  working: 'Working',
  needs: 'Needs you',
  ready: 'Your turn',
  shell: 'Claude exited',
  exited: 'Stopped',
};

const TERM_THEME = {
  background: '#1a212c',
  foreground: '#dce3ec',
  cursor: '#f2b544',
  cursorAccent: '#1a212c',
  selectionBackground: '#3b4a61',
  black: '#1a212c', brightBlack: '#6b7485',
  red: '#e57373', brightRed: '#f09090',
  green: '#7cc48a', brightGreen: '#9bd8a6',
  yellow: '#f2b544', brightYellow: '#f7cb73',
  blue: '#7fa7f0', brightBlue: '#a3c0f5',
  magenta: '#c59be8', brightMagenta: '#d7b8f0',
  cyan: '#5cc8b0', brightCyan: '#86d9c6',
  white: '#dce3ec', brightWhite: '#ffffff',
};

const entries = new Map(); // id -> { id, session, term, fit, el }
let order = [];
let activeId = null;
let settings = {};

// ---------- terminals ----------

function createEntry(session) {
  const el = document.createElement('div');
  el.className = 'term-host';
  $('terms').append(el);

  const term = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorBlink: true,
    scrollback: 10000,
    theme: TERM_THEME,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri)));
  // Emoji are two cells wide; xterm's default Unicode 6 widths count them as one.
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(el);

  const entry = { id: session.id, session, term, fit, el, cols: 0, rows: 0 };
  term.onData((data) => api.write(session.id, data));
  term.attachCustomKeyEventHandler((e) => terminalKey(entry, e));
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => dropFiles(entry, e));

  entries.set(session.id, entry);
  order.push(session.id);
  return entry;
}

function fitEntry(entry) {
  try { entry.fit.fit(); } catch { return; }
  const { cols, rows } = entry.term;
  if (cols !== entry.cols || rows !== entry.rows) {
    entry.cols = cols;
    entry.rows = rows;
    api.resize(entry.id, cols, rows);
  }
}

async function startEntry(entry, resume) {
  try { entry.fit.fit(); } catch { /* not laid out yet */ }
  entry.cols = entry.term.cols;
  entry.rows = entry.term.rows;
  const result = await api.start({ id: entry.id, cols: entry.cols, rows: entry.rows, resume });
  if (!result.ok) entry.term.writeln(`\r\n\x1b[33m${result.error}\x1b[0m`);
}

// Returns false when the app handles the key so xterm ignores it.
function terminalKey(entry, e) {
  if (e.type !== 'keydown') return true;
  if (isAppShortcut(e)) return false;

  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;

  if (ctrl && e.key.toLowerCase() === 'c' && (e.shiftKey || entry.term.hasSelection())) {
    const text = entry.term.getSelection();
    if (text) api.writeClipboard(text);
    entry.term.clearSelection();
    e.preventDefault();
    return false;
  }

  if (ctrl && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    api.readClipboard().then(({ text, hasImage }) => {
      if (text) entry.term.paste(text);
      // Alt+V makes Claude Code on Windows read the image from the system clipboard itself.
      else if (hasImage) api.write(entry.id, '\x1bv');
    });
    return false;
  }

  // Shift+Enter inserts a newline in the Claude Code prompt instead of submitting.
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    api.write(entry.id, '\x1b\r');
    return false;
  }

  return true;
}

// Pastes the dropped file paths, the same as Windows Terminal. Claude Code attaches an image path as an image.
function dropFiles(entry, e) {
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  if (!paths.length) return;
  entry.term.paste(paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' '));
  entry.term.focus();
}

// ---------- selection ----------

function select(id) {
  const entry = entries.get(id);
  if (!entry) return;
  activeId = id;
  for (const [key, e] of entries) e.el.classList.toggle('active', key === id);
  api.focus(id);
  render();
  requestAnimationFrame(() => {
    fitEntry(entry);
    entry.term.focus();
  });
}

function step(delta) {
  if (!order.length) return;
  const i = Math.max(0, order.indexOf(activeId));
  select(order[(i + delta + order.length) % order.length]);
}

// ---------- rendering ----------

function since(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function folderTail(cwd) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('\\');
}

function renderList() {
  const list = $('session-list');
  list.replaceChildren();

  order.forEach((id, index) => {
    const { session } = entries.get(id);
    const li = document.createElement('li');
    li.className = 'session';
    li.dataset.status = session.status;
    if (id === activeId) li.setAttribute('aria-current', 'true');

    const main = document.createElement('button');
    main.className = 'session-main';
    main.title = index < 9 ? `${session.cwd}\nCtrl+Shift+${index + 1}` : session.cwd;
    main.addEventListener('click', () => select(id));

    const dot = document.createElement('span');
    dot.className = 'dot';

    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;

    const state = document.createElement('span');
    state.className = 'session-state';
    state.textContent = STATUS_LABEL[session.status] || session.status;

    const time = document.createElement('span');
    time.className = 'session-time';
    time.textContent = since(session.since);

    const folder = document.createElement('span');
    folder.className = 'session-folder';
    folder.textContent = folderTail(session.cwd);

    main.append(dot, name, time, state, folder);

    const close = document.createElement('button');
    close.className = 'session-close';
    close.title = 'Close session';
    close.setAttribute('aria-label', `Close ${session.name}`);
    close.textContent = '×';
    close.addEventListener('click', () => closeSession(id));

    li.append(main, close);
    list.append(li);
  });
}

function renderBar() {
  const entry = entries.get(activeId);
  $('stage-bar').hidden = !entry;
  $('empty').hidden = entries.size > 0;
  if (!entry) return;

  const { session } = entry;
  const nameInput = $('active-name');
  if (document.activeElement !== nameInput) nameInput.value = session.name;
  $('active-cwd').textContent = session.cwd;

  const detail = $('active-detail');
  const showDetail = (session.status === 'needs' || session.status === 'exited') && session.detail;
  detail.hidden = !showDetail;
  detail.textContent = showDetail ? session.detail : '';
  $('stage-bar').dataset.status = session.status;
}

function renderTitle() {
  const waiting = [...entries.values()].filter((e) => e.session.status === 'needs').length;
  document.title = waiting ? `Manifold (${waiting} need you)` : 'Manifold';
}

function render() {
  renderList();
  renderBar();
  renderTitle();
}

// ---------- actions ----------

async function closeSession(id) {
  const entry = entries.get(id);
  if (!entry) return;
  const busy = ['working', 'needs', 'starting'].includes(entry.session.status);
  if (busy && !confirm(`${entry.session.name} is still running. Close it and stop Claude?`)) return;

  await api.close(id);
  entry.term.dispose();
  entry.el.remove();
  entries.delete(id);
  const i = order.indexOf(id);
  order = order.filter((k) => k !== id);

  if (activeId === id) {
    activeId = null;
    const next = order[Math.min(i, order.length - 1)];
    if (next) select(next);
  }
  render();
}

async function restartActive() {
  const entry = entries.get(activeId);
  if (!entry) return;
  entry.term.writeln('\r\n\x1b[90mRestarting…\x1b[0m');
  const result = await api.restart({ id: entry.id, cols: entry.term.cols, rows: entry.term.rows });
  if (!result.ok) entry.term.writeln(`\r\n\x1b[33m${result.error}\x1b[0m`);
}

// ---------- new session dialog ----------

async function openNewDialog() {
  const presets = await api.presets();
  const presetSelect = $('f-preset');
  presetSelect.replaceChildren(...presets.map((p) => new Option(p.name, p.id)));
  const lastPreset = localStorage.getItem('lastPreset');
  if (lastPreset && presets.some((p) => p.id === lastPreset)) presetSelect.value = lastPreset;

  $('f-cwd').value = localStorage.getItem('lastCwd') || '';
  $('f-name').value = '';
  $('f-error').hidden = true;
  $('new-dialog').showModal();
  $('f-cwd').focus();
}

$('f-browse').addEventListener('click', async () => {
  const folder = await api.pickFolder($('f-cwd').value.trim());
  if (folder) $('f-cwd').value = folder;
});

$('new-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancel') return; // let the dialog close
  e.preventDefault();

  const cwd = $('f-cwd').value.trim();
  const error = $('f-error');
  if (!cwd) {
    error.textContent = 'Choose a project folder.';
    error.hidden = false;
    return;
  }

  const presetId = $('f-preset').value;
  const result = await api.create({ cwd, name: $('f-name').value, presetId });
  if (!result.ok) {
    error.textContent = result.error;
    error.hidden = false;
    return;
  }

  localStorage.setItem('lastCwd', result.session.cwd);
  localStorage.setItem('lastPreset', presetId);
  $('new-dialog').close();

  const entry = createEntry(result.session);
  select(entry.id);
  requestAnimationFrame(() => startEntry(entry, false));
});

// ---------- shortcuts ----------

function isAppShortcut(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === 'Tab') return true;
  if (e.shiftKey && (e.key.toLowerCase() === 'n' || /^Digit[1-9]$/.test(e.code))) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  if (!isAppShortcut(e) || $('new-dialog').open) return;
  e.preventDefault();
  if (e.key === 'Tab') step(e.shiftKey ? -1 : 1);
  else if (e.key.toLowerCase() === 'n') openNewDialog();
  else {
    const id = order[Number(e.code.slice(5)) - 1];
    if (id) select(id);
  }
});

// ---------- wiring ----------

$('new-btn').addEventListener('click', openNewDialog);
$('empty-new').addEventListener('click', openNewDialog);
$('settings-btn').addEventListener('click', () => api.editSettings());
$('restart-btn').addEventListener('click', restartActive);

const nameInput = $('active-name');
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nameInput.blur();
  if (e.key === 'Escape') {
    nameInput.value = entries.get(activeId)?.session.name || '';
    nameInput.blur();
  }
});
nameInput.addEventListener('blur', async () => {
  const entry = entries.get(activeId);
  const name = nameInput.value.trim();
  if (!entry || !name || name === entry.session.name) {
    renderBar();
    return;
  }
  const updated = await api.rename(entry.id, name);
  if (updated) entry.session.name = updated.name;
  render();
});

api.onData((id, data) => entries.get(id)?.term.write(data));

api.onStatus((id, state) => {
  const entry = entries.get(id);
  if (!entry) return;
  Object.assign(entry.session, state);
  render();
});

api.onActivate((id) => select(id));

api.onSettings((next) => {
  settings = next;
  for (const entry of entries.values()) {
    entry.term.options.fontFamily = settings.fontFamily;
    entry.term.options.fontSize = settings.fontSize;
    entry.term.options.lineHeight = settings.lineHeight;
  }
  const entry = entries.get(activeId);
  if (entry) fitEntry(entry);
});

new ResizeObserver(() => {
  const entry = entries.get(activeId);
  if (entry) fitEntry(entry);
}).observe($('terms'));

setInterval(renderList, 30_000);

(async function boot() {
  const { sessions, activeId: savedActive, settings: saved } = await api.init();
  settings = saved;
  const created = sessions.map(createEntry);

  const first = entries.has(savedActive) ? savedActive : created[0]?.id;
  if (first) select(first);
  else render();

  // Bring back every saved session, resuming its last conversation.
  requestAnimationFrame(() => created.forEach((entry) => startEntry(entry, true)));
})();
