const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  checkNow: () => ipcRenderer.invoke('check:now'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authHelp: () => ipcRenderer.invoke('auth:help'),
  openAlert: (url) => ipcRenderer.invoke('alert:open', url),
  snoozeAlert: (url, mode) => ipcRenderer.invoke('alert:snooze', url, mode),
  unsnoozeAlert: (url) => ipcRenderer.invoke('alert:unsnooze', url),
  onStateUpdate: (handler) => {
    ipcRenderer.on('state:update', (_evt, state) => handler(state));
  },
});
