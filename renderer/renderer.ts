interface Window { api: any; }

const orgEl = document.getElementById('org') as HTMLInputElement;
const authorsEl = document.getElementById('authors') as HTMLTextAreaElement;
const intervalEl = document.getElementById('interval') as HTMLInputElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const checkBtn = document.getElementById('checkBtn') as HTMLButtonElement;
const reloadBtn = document.getElementById('reloadBtn') as HTMLButtonElement;
const alertsEl = document.getElementById('alerts') as HTMLDivElement;
const clearAlertsBtn = document.getElementById('clearAlertsBtn') as HTMLButtonElement;
const authStatusEl = document.getElementById('authStatus') as HTMLParagraphElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const diagEl = document.getElementById('diag') as HTMLParagraphElement;
const logsEl = document.getElementById('logs') as HTMLDivElement;
const logsContainer = document.getElementById('logsContainer') as HTMLDivElement;
const logsToggleBtn = document.getElementById('logsToggleBtn') as HTMLButtonElement;
const clearLogsBtn = document.getElementById('clearLogsBtn') as HTMLButtonElement;

let logsCollapsed = true;

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
    div.className = `alert${a.opened ? ' opened' : ''}`;
    const draftBadge = a.isDraft ? '<span class="badge draft">DRAFT</span>' : '';
    const kindBadge = `<span class="badge ${a.kind}">${a.kind === 'new' ? 'NEW' : 'UPDATED'}</span>`;
    div.innerHTML = `
      <div class="title">${kindBadge}${draftBadge} ${escapeHtml(a.repo)} #${a.number}</div>
      <div>${escapeHtml(a.title)}</div>
      <div class="meta">@${escapeHtml(a.author)} • PR state: ${escapeHtml(a.state)} • seen ${relTime(a.createdAt)}</div>
      <div class="meta">${snoozedUntil > Date.now() ? `Snoozed until ${new Date(snoozedUntil).toLocaleString()}` : ''}</div>
      <div class="actions">
        <button class="open" data-url="${a.url}">Open</button>
        <button class="snooze" data-url="${a.url}" data-mode="1h">Snooze 1h</button>
        <button class="snooze" data-url="${a.url}" data-mode="tomorrow">Snooze till tomorrow</button>
        ${snoozedUntil > Date.now() ? `<button class="unsnooze" data-url="${a.url}">Unsnooze</button>` : ''}
        <button class="dismiss" data-id="${a.id}">Dismiss</button>
      </div>
    `;
    alertsEl.appendChild(div);
  }

  alertsEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      const id = btn.getAttribute('data-id');
      if (btn.classList.contains('open') && url) return window.api.openAlert(url);
      if (btn.classList.contains('unsnooze') && url) return window.api.unsnoozeAlert(url);
      if (btn.classList.contains('snooze') && url) {
        const mode = btn.getAttribute('data-mode');
        return window.api.snoozeAlert(url, mode);
      }
      if (btn.classList.contains('dismiss') && id) return window.api.dismissAlert(id);
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

function updateLogsVisibility() {
  logsContainer.style.display = logsCollapsed ? 'none' : '';
  logsToggleBtn.textContent = logsCollapsed ? 'Show' : 'Hide';
}

function render(state: any, auth?: { ok: boolean }) {
  orgEl.value = state.config.org || '';
  authorsEl.value = state.config.authorsText || '';
  intervalEl.value = String(state.config.intervalMinutes || 5);
  statusEl.textContent = `Last check: ${fmtTime(state.lastCheckAt)}${state.lastError ? ` • Error: ${state.lastError}` : ''}`;
  authStatusEl.textContent = auth?.ok
    ? 'GitHub auth: connected'
    : 'GitHub auth: not connected. Run `gh auth login` in terminal.';
  const d = state.diagnostics;
  if (d) {
    diagEl.textContent = `v${d.version} • state: ${d.statePath} • log: ${d.appLogPath}`;
  }
  renderAlerts(state);
  renderLogs(state);
  updateLogsVisibility();
}

async function saveConfigUi() {
  const cfg = {
    org: orgEl.value,
    authorsText: authorsEl.value,
    intervalMinutes: Number(intervalEl.value || 5),
  };
  await window.api.saveConfig(cfg);
  statusEl.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
}

saveBtn.addEventListener('click', async () => {
  await saveConfigUi();
});

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  checkBtn.textContent = 'Checking…';
  const res = await window.api.checkNow();
  checkBtn.disabled = false;
  checkBtn.textContent = 'Check now';
  statusEl.textContent = res?.message || 'Checked.';
});

reloadBtn.addEventListener('click', async () => {
  await window.api.reloadState();
  statusEl.textContent = `Reloaded from disk at ${new Date().toLocaleTimeString()}`;
});

clearLogsBtn.addEventListener('click', async () => {
  await window.api.clearLogs();
});

clearAlertsBtn.addEventListener('click', async () => {
  await window.api.clearAlerts();
});

logsToggleBtn.addEventListener('click', () => {
  logsCollapsed = !logsCollapsed;
  updateLogsVisibility();
});

let autoSaveTimer: number | undefined;
function scheduleAutoSave() {
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    saveConfigUi().catch(() => {
      statusEl.textContent = 'Auto-save failed';
    });
  }, 500) as unknown as number;
}

orgEl.addEventListener('input', scheduleAutoSave);
authorsEl.addEventListener('input', scheduleAutoSave);
intervalEl.addEventListener('input', scheduleAutoSave);

window.api.onStateUpdate((state: any) => {
  render(state, { ok: !state.lastError || !String(state.lastError).includes('auth') });
});

(async () => {
  const initial = await window.api.getState();
  render(initial, initial.auth);
})();
