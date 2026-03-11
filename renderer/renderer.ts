export {};

const orgEl = document.getElementById('org') as HTMLInputElement;
const authorsEl = document.getElementById('authors') as HTMLTextAreaElement;
const intervalEl = document.getElementById('interval') as HTMLInputElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const checkBtn = document.getElementById('checkBtn') as HTMLButtonElement;
const alertsEl = document.getElementById('alerts') as HTMLDivElement;
const authStatusEl = document.getElementById('authStatus') as HTMLParagraphElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const logsEl = document.getElementById('logs') as HTMLDivElement;
const clearLogsBtn = document.getElementById('clearLogsBtn') as HTMLButtonElement;

declare global {
  interface Window {
    api: any;
  }
}

function fmtTime(ts?: number | null) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function relTime(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function escapeHtml(text: string) {
  return (text || '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[c] as string));
}

function renderAlerts(state: any) {
  const alerts = state.alerts || [];
  if (!alerts.length) {
    alertsEl.innerHTML = '<p class="empty">No alerts yet.</p>';
    return;
  }

  alertsEl.innerHTML = '';
  for (const a of alerts) {
    const snoozedUntil = state.snoozes?.[a.url] || 0;
    const div = document.createElement('div');
    div.className = 'alert';
    div.innerHTML = `
      <div class="title">${a.kind === 'new' ? 'NEW' : 'UPDATED'} • ${escapeHtml(a.repo)} #${a.number}</div>
      <div>${escapeHtml(a.title)}</div>
      <div class="meta">@${escapeHtml(a.author)} • PR state: ${escapeHtml(a.state)} • seen ${relTime(a.createdAt)}</div>
      <div class="meta">${snoozedUntil > Date.now() ? `Snoozed until ${new Date(snoozedUntil).toLocaleString()}` : 'Not snoozed'}</div>
      <div class="actions">
        <button class="open" data-url="${a.url}">Open</button>
        <button class="snooze" data-url="${a.url}" data-mode="1h">Snooze 1h</button>
        <button class="snooze" data-url="${a.url}" data-mode="tomorrow">Snooze till tomorrow</button>
        ${snoozedUntil > Date.now() ? `<button class="unsnooze" data-url="${a.url}" data-mode="off">Unsnooze</button>` : ''}
      </div>
    `;
    alertsEl.appendChild(div);
  }

  alertsEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      const mode = btn.getAttribute('data-mode');
      if (!url) return;
      if (!mode) return window.api.openAlert(url);
      if (mode === 'off') return window.api.unsnoozeAlert(url);
      await window.api.snoozeAlert(url, mode);
    });
  });
}

function renderLogs(state: any) {
  const logs = state.logs || [];
  if (!logs.length) {
    logsEl.innerHTML = '<p class="empty">No logs yet.</p>';
    return;
  }

  logsEl.innerHTML = logs.map((l: any) => {
    const ts = new Date(l.ts).toLocaleString();
    return `<div class="log-item"><span class="log-ts">${ts}</span><span class="log-level ${l.level}">${String(l.level).toUpperCase()}</span>${escapeHtml(l.message || '')}</div>`;
  }).join('');
}

function render(state: any, auth?: { ok: boolean }) {
  orgEl.value = state.config.org || '';
  authorsEl.value = state.config.authorsText || '';
  intervalEl.value = String(state.config.intervalMinutes || 5);
  statusEl.textContent = `Last check: ${fmtTime(state.lastCheckAt)}${state.lastError ? ` • Error: ${state.lastError}` : ''}`;
  authStatusEl.textContent = auth?.ok
    ? 'GitHub auth: connected'
    : 'GitHub auth: not connected. Run `gh auth login` in terminal.';
  renderAlerts(state);
  renderLogs(state);
}

saveBtn.addEventListener('click', async () => {
  const cfg = {
    org: orgEl.value,
    authorsText: authorsEl.value,
    intervalMinutes: Number(intervalEl.value || 5),
  };
  await window.api.saveConfig(cfg);
  statusEl.textContent = 'Saved.';
});

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  const res = await window.api.checkNow();
  checkBtn.disabled = false;
  statusEl.textContent = res?.message || 'Checked.';
});

clearLogsBtn.addEventListener('click', async () => {
  await window.api.clearLogs();
});

window.api.onStateUpdate((state: any) => {
  render(state, { ok: !state.lastError || !String(state.lastError).includes('auth') });
});

(async () => {
  const initial = await window.api.getState();
  render(initial, initial.auth);
})();
