'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zhixueDesktop', {
  getSetupState: () => ipcRenderer.invoke('setup:get-state'),
  testConnection: (input) => ipcRenderer.invoke('setup:test-connection', input),
  saveSetup: (input) => ipcRenderer.invoke('setup:save', input),
  openDeepSeekConsole: () => ipcRenderer.invoke('setup:open-deepseek-console'),
  closeSetup: () => ipcRenderer.invoke('setup:close'),
});
