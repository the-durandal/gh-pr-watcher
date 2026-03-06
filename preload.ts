import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveConfig: (cfg: { org: string; authorsText: string; intervalMinutes: number }) => ipcRenderer.invoke('config:save', cfg),
  checkNow: () => ipcRenderer.invoke('check:now'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authHelp: () => ipcRenderer.invoke('auth:help'),
  openAlert: (url: string) => ipcRenderer.invoke('alert:open', url),
  snoozeAlert: (url: string, mode: '1h' | 'tomorrow') => ipcRenderer.invoke('alert:snooze', url, mode),
  unsnoozeAlert: (url: string) => ipcRenderer.invoke('alert:unsnooze', url),
  onStateUpdate: (handler: (state: any) => void) => {
    ipcRenderer.on('state:update', (_evt, state) => handler(state));
  },
});
