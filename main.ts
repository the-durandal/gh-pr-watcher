import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';

type LogEntry = {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
};

type AppState = {
  config: {
    org: string;
    authorsText: string;
    intervalMinutes: number;
    autoStart: boolean;
  };
  seen: Record<string, { updatedAt: string; state: string; title: string }>;
  snoozes: Record<string, number>;
  alerts: Alert[];
  logs: LogEntry[];
  lastCheckAt: number | null;
  lastError: string | null;
};

type Alert = {
  id: string;
  kind: 'new' | 'updated';
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state: string;
  repo: string;
  author: string;
  isDraft: boolean;
  createdAt: number;
  opened: boolean;
};

type PR = Omit<Alert, 'id' | 'kind' | 'createdAt' | 'opened'>;

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;

const statePath = () => path.join(app.getPath('userData'), 'state.json');

const defaultState: AppState = {
  config: {
    org: '',
    authorsText: '',
    intervalMinutes: 5,
    autoStart: true,
  },
  seen: {},
  snoozes: {},
  alerts: [],
  logs: [],
  lastCheckAt: null,
  lastError: null,
};

let state = loadState();

function loadState(): AppState {
  try {
    const p = statePath();
    if (!fs.existsSync(p)) return { ...defaultState };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...defaultState,
      ...parsed,
      config: { ...defaultState.config, ...(parsed.config || {}) },
      seen: parsed.seen || {},
      snoozes: parsed.snoozes || {},
      alerts: parsed.alerts || [],
      logs: parsed.logs || [],
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

function addLog(level: LogEntry['level'], message: string) {
  state.logs.unshift({ ts: Date.now(), level, message });
  if (state.logs.length > 500) state.logs = state.logs.slice(0, 500);
}

function clearLogs() {
  state.logs = [];
}

function getAuthors(): string[] {
  return (state.config.authorsText || '')
    .split(/[\n,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function compact(s: string, max = 280): string {
  const one = (s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function runGh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; error: Error | null }> {
  const cmd = `gh ${args.join(' ')}`;
  const started = Date.now();
  addLog('info', `CMD start: ${cmd}`);

  return new Promise((resolve) => {
    execFile('gh', args, { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const took = Date.now() - started;
      const out = stdout || '';
      const err = stderr || '';

      if (error) {
        const code = (error as any)?.code ?? 'unknown';
        addLog('error', `CMD fail (${took}ms, code=${code}): ${cmd}`);
        if (err.trim()) addLog('error', `stderr: ${compact(err)}`);
        else if (out.trim()) addLog('error', `stdout: ${compact(out)}`);
      } else {
        addLog('info', `CMD ok (${took}ms): ${cmd}`);
        if (err.trim()) addLog('warn', `stderr: ${compact(err)}`);
      }

      resolve({ ok: !error, stdout: out, stderr: err, error });
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

function isSnoozed(url: string): boolean {
  const until = state.snoozes[url] || 0;
  return until > Date.now();
}

function addAlert(alert: Alert) {
  state.alerts.unshift(alert);
  if (state.alerts.length > 300) state.alerts = state.alerts.slice(0, 300);
}

function makeNotification(alert: Alert) {
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

async function fetchPRs(): Promise<PR[]> {
  const org = (state.config.org || '').trim();
  const authors = getAuthors();
  if (!org || authors.length === 0) {
    addLog('warn', 'Skipping check: org or authors are not configured.');
    return [];
  }

  addLog('info', `Checking PRs for org=${org}, authors=${authors.join(', ')}`);

  const all: PR[] = [];
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
    if (!res.ok) throw new Error((res.stderr || res.stdout || 'gh search prs failed').trim());

    let rows: any[] = [];
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

  const dedup = new Map<string, PR>();
  for (const pr of all) dedup.set(pr.url, pr);
  return Array.from(dedup.values());
}

async function runCheck(manual = false) {
  try {
    addLog('info', manual ? 'Manual check started.' : 'Scheduled check started.');
    const auth = await checkAuth();
    if (!auth.ok) {
      state.lastError = 'GitHub auth missing. Run: gh auth login';
      addLog('error', state.lastError);
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
      const kind: 'new' | 'updated' = !prev ? 'new' : 'updated';

      if (changed) {
        const alert: Alert = {
          id: `${pr.url}#${pr.updatedAt}`,
          kind,
          ...pr,
          createdAt: now,
          opened: false,
        };

        addAlert(alert);
        addLog('info', `${kind.toUpperCase()} ${pr.repo} #${pr.number} by @${pr.author}`);
        if (!isSnoozed(pr.url)) {
          makeNotification(alert);
          notifications += 1;
        } else {
          addLog('info', `Notification suppressed (snoozed): ${pr.repo} #${pr.number}`);
        }
      }

      state.seen[pr.url] = { updatedAt: pr.updatedAt, state: pr.state, title: pr.title };
    }

    state.lastError = null;
    state.lastCheckAt = now;
    addLog('info', `Check complete: ${prs.length} PRs scanned, ${notifications} notifications sent.`);
    saveState();
    broadcastState();

    if (manual) return { ok: true, message: `Checked ${prs.length} PRs, ${notifications} notifications.` };
    return { ok: true };
  } catch (err: any) {
    state.lastError = err?.message || String(err);
    addLog('error', `Check failed: ${state.lastError}`);
    state.lastCheckAt = Date.now();
    saveState();
    broadcastState();
    return { ok: false, message: state.lastError };
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const ms = Math.max(1, Number(state.config.intervalMinutes || 5)) * 60_000;
  addLog('info', `Polling interval set to ${Math.round(ms / 60000)} minute(s).`);
  pollTimer = setInterval(() => runCheck(false), ms);
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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      win?.hide();
    }
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
    { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit(); } },
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
    logs: state.logs.slice(0, 200),
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
    logs: state.logs.slice(0, 200),
    snoozes: state.snoozes,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    authors: getAuthors(),
    auth,
  };
});

ipcMain.handle('config:save', async (_evt, cfg: { org: string; authorsText: string; intervalMinutes: number }) => {
  state.config = {
    ...state.config,
    org: (cfg.org || '').trim(),
    authorsText: (cfg.authorsText || '').trim(),
    intervalMinutes: Math.max(1, Number(cfg.intervalMinutes || 5)),
  };
  addLog('info', `Config saved: org=${state.config.org}, interval=${state.config.intervalMinutes}m`);
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

ipcMain.handle('alert:open', async (_evt, url: string) => {
  addLog('info', `Opened PR in browser: ${url}`);
  shell.openExternal(url);
  saveState();
  broadcastState();
  return { ok: true };
});

ipcMain.handle('alert:snooze', async (_evt, url: string, mode: '1h' | 'tomorrow') => {
  if (!url) return { ok: false };
  let until = 0;
  if (mode === '1h') until = Date.now() + 60 * 60 * 1000;
  if (mode === 'tomorrow') until = tomorrow9am();
  if (until > 0) {
    state.snoozes[url] = until;
    addLog('info', `Snoozed ${url} until ${new Date(until).toLocaleString()}`);
  }
  saveState();
  broadcastState();
  return { ok: true, until };
});

ipcMain.handle('alert:unsnooze', async (_evt, url: string) => {
  delete state.snoozes[url];
  addLog('info', `Removed snooze: ${url}`);
  saveState();
  broadcastState();
  return { ok: true };
});

ipcMain.handle('logs:clear', async () => {
  clearLogs();
  addLog('info', 'Logs cleared.');
  saveState();
  broadcastState();
  return { ok: true };
});

app.whenReady().then(async () => {
  addLog('info', 'App started.');
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
  (app as any).isQuitting = true;
});

app.on('window-all-closed', () => {
  // no-op: app lifecycle is controlled by tray + explicit Quit.
});
