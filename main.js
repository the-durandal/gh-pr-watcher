const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let tray = null;
let win = null;
let pollTimer = null;

const statePath = () => path.join(app.getPath('userData'), 'state.json');

const defaultState = {
  config: {
    org: '',
    authorsText: '',
    intervalMinutes: 5,
    autoStart: true,
  },
  seen: {}, // url -> { updatedAt, state, title }
  snoozes: {}, // url -> unix ms
  alerts: [], // newest first
  lastCheckAt: null,
  lastError: null,
};

let state = loadState();

function loadState() {
  try {
    const p = statePath();
    if (!fs.existsSync(p)) return { ...defaultState };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultState,
      ...parsed,
      config: { ...defaultState.config, ...(parsed.config || {}) },
      seen: parsed.seen || {},
      snoozes: parsed.snoozes || {},
      alerts: parsed.alerts || [],
    };
  } catch {
    return { ...defaultState };
  }
}

function saveState() {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function getAuthors() {
  return (state.config.authorsText || '')
    .split(/[\n,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function runGh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error });
    });
  });
}

async function checkAuth() {
  const res = await runGh(['auth', 'status']);
  return {
    ok: res.ok,
    details: res.ok ? 'Authenticated' : (res.stderr || res.stdout || 'Not authenticated').trim(),
  };
}

function isSnoozed(url) {
  const until = state.snoozes[url] || 0;
  return until > Date.now();
}

function addAlert(alert) {
  state.alerts.unshift(alert);
  if (state.alerts.length > 300) state.alerts = state.alerts.slice(0, 300);
}

function makeNotification(alert) {
  const notif = new Notification({
    title: alert.kind === 'new' ? `New PR by @${alert.author}` : `PR updated by @${alert.author}`,
    body: `${alert.repo} #${alert.number}: ${alert.title}`,
    silent: false,
  });

  notif.on('click', () => shell.openExternal(alert.url));
  notif.show();
}

function tomorrow9am() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

async function fetchPRs() {
  const org = (state.config.org || '').trim();
  const authors = getAuthors();
  if (!org || authors.length === 0) return [];

  const all = [];
  for (const author of authors) {
    const query = `org:${org} author:${author}`;
    const args = [
      'search',
      'prs',
      query,
      '--limit',
      '100',
      '--json',
      'number,title,url,updatedAt,state,repository,author,isDraft',
    ];
    const res = await runGh(args);
    if (!res.ok) {
      throw new Error((res.stderr || res.stdout || 'gh search prs failed').trim());
    }
    let rows = [];
    try {
      rows = JSON.parse(res.stdout || '[]');
    } catch {
      rows = [];
    }

    for (const pr of rows) {
      all.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        updatedAt: pr.updatedAt,
        state: pr.state,
        repo: pr.repository?.nameWithOwner || 'unknown',
        author: pr.author?.login || author,
        isDraft: !!pr.isDraft,
      });
    }
  }

  const dedup = new Map();
  for (const pr of all) dedup.set(pr.url, pr);
  return Array.from(dedup.values());
}

async function runCheck(manual = false) {
  try {
    const auth = await checkAuth();
    if (!auth.ok) {
      state.lastError = 'GitHub auth missing. Run: gh auth login';
      state.lastCheckAt = Date.now();
      saveState();
      broadcastState();
      return { ok: false, message: state.lastError };
    }

    const prs = await fetchPRs();
    const now = Date.now();
    let notifications = 0;

    for (const pr of prs) {
      const prev = state.seen[pr.url];
      const changed = !prev || prev.updatedAt !== pr.updatedAt || prev.state !== pr.state;
      const kind = !prev ? 'new' : 'updated';

      if (changed) {
        const alert = {
          id: `${pr.url}#${pr.updatedAt}`,
          kind,
          ...pr,
          createdAt: now,
          opened: false,
        };

        addAlert(alert);
        if (!isSnoozed(pr.url)) {
          makeNotification(alert);
          notifications += 1;
        }
      }

      state.seen[pr.url] = { updatedAt: pr.updatedAt, state: pr.state, title: pr.title };
    }

    state.lastError = null;
    state.lastCheckAt = now;
    saveState();
    broadcastState();

    if (manual) return { ok: true, message: `Checked ${prs.length} PRs, ${notifications} notifications.` };
    return { ok: true };
  } catch (err) {
    state.lastError = err.message || String(err);
    state.lastCheckAt = Date.now();
    saveState();
    broadcastState();
    return { ok: false, message: state.lastError };
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const ms = Math.max(1, Number(state.config.intervalMinutes || 5)) * 60_000;
  pollTimer = setInterval(() => runCheck(false), ms);
}

function getWindowHtml() {
  return path.join(__dirname, 'renderer', 'index.html');
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 640,
    show: false,
    resizable: true,
    fullscreenable: false,
    title: 'GH PR Watcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(getWindowHtml());
  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });
}

function createTray() {
  const img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAeUlEQVR4AWP4TwAw/P//H4z/Gf4zMDD8x8DA8P//fzA8w8DAwPD//38wMDAw/P///x8MDAwM///fHzAwMPz//z8YGBj+//8fDAwM/P//PxgYGP7//x8MDAz8//8/GhgY/v//HwwMDPz//z8YGBj+//8fDABiQh0T7iwfngAAAABJRU5ErkJggg==');
  tray = new Tray(img);
  tray.setToolTip('GH PR Watcher');

  const menu = Menu.buildFromTemplate([
    { label: 'Open GH PR Watcher', click: () => showWindow() },
    { label: 'Check Now', click: () => runCheck(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
}

function showWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.focus();
    return;
  }
  win.show();
  win.focus();
}

function broadcastState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state:update', {
    config: state.config,
    alerts: state.alerts.slice(0, 100),
    snoozes: state.snoozes,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    authors: getAuthors(),
  });
}

ipcMain.handle('state:get', async () => {
  const auth = await checkAuth();
  return {
    config: state.config,
    alerts: state.alerts.slice(0, 100),
    snoozes: state.snoozes,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    authors: getAuthors(),
    auth,
  };
});

ipcMain.handle('config:save', async (_evt, cfg) => {
  state.config = {
    ...state.config,
    org: (cfg.org || '').trim(),
    authorsText: (cfg.authorsText || '').trim(),
    intervalMinutes: Math.max(1, Number(cfg.intervalMinutes || 5)),
  };
  saveState();
  restartPolling();
  broadcastState();
  return { ok: true };
});

ipcMain.handle('check:now', async () => runCheck(true));

ipcMain.handle('auth:status', async () => checkAuth());

ipcMain.handle('auth:help', async () => {
  const cmd = process.platform === 'darwin'
    ? `osascript -e 'tell app "Terminal" to do script "gh auth login"'`
    : 'gh auth login';
  return { cmd };
});

ipcMain.handle('alert:open', async (_evt, url) => {
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('alert:snooze', async (_evt, url, mode) => {
  if (!url) return { ok: false };
  let until = 0;
  if (mode === '1h') until = Date.now() + 60 * 60 * 1000;
  if (mode === 'tomorrow') until = tomorrow9am();
  if (until > 0) state.snoozes[url] = until;
  saveState();
  broadcastState();
  return { ok: true, until };
});

ipcMain.handle('alert:unsnooze', async (_evt, url) => {
  delete state.snoozes[url];
  saveState();
  broadcastState();
  return { ok: true };
});

app.whenReady().then(async () => {
  createWindow();
  createTray();
  restartPolling();
  await runCheck(false);
  broadcastState();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
