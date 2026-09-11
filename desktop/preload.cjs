'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const titleBarCss = fs.readFileSync(path.join(__dirname, 'assets', 'titlebar.css'), 'utf8');
// 以 author 源注入：zhixue-* 命名空间样式需要能压过 Tailwind preflight 的
// `* { padding: 0; border: 0 }` 重置；user 源在级联里天然低于 author，会被压掉。
void webFrame.insertCSS(titleBarCss, { cssOrigin: 'author' });

const icons = {
  minimize: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5h8" /></svg>',
  maximize:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx=".5" /></svg>',
  restore: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M2 4h6v6H2z" /></svg>',
  close: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg>',
  settings:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 2h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-2z"/><circle cx="11.5" cy="11" r="3"/></svg>',
};

function makeControl(action, label, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `zhixue-window-control zhixue-window-${action}`;
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener('click', () => ipcRenderer.send('window:control', action));
  return button;
}

function mountTitleBar() {
  if (!document.body || document.getElementById('zhixue-desktop-titlebar')) return;

  document.documentElement.classList.add('zhixue-desktop-shell');
  const titleBar = document.createElement('header');
  titleBar.id = 'zhixue-desktop-titlebar';
  titleBar.setAttribute('aria-label', '窗口标题栏');

  const brand = document.createElement('div');
  brand.className = 'zhixue-titlebar-brand';
  // 真实产品 logo 只在 Web 源（主窗口）下可用；file:// 的设置窗口回退为文字块。
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    brand.innerHTML =
      '<img class="zhixue-titlebar-logo" src="/openmaic-mark.png" alt="" />' +
      '<span>智学课堂</span>';
    const logo = brand.querySelector('img');
    logo.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'zhixue-titlebar-mark';
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = '智';
      logo.replaceWith(fallback);
    });
  } else {
    brand.innerHTML =
      '<span class="zhixue-titlebar-mark" aria-hidden="true">智</span><span>智学课堂</span>';
  }

  const controls = document.createElement('div');
  controls.className = 'zhixue-window-controls';
  const minimizeButton = makeControl('minimize', '最小化', icons.minimize);
  const maximizeButton = makeControl('maximize', '最大化', icons.maximize);
  const closeButton = makeControl('close', '关闭', icons.close);
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'zhixue-window-control zhixue-open-settings';
    settingsButton.title = '设置';
    settingsButton.setAttribute('aria-label', '设置');
    settingsButton.innerHTML = icons.settings;
    settingsButton.addEventListener('click', () => ipcRenderer.send('settings:open'));
    controls.append(settingsButton);
  }
  controls.append(minimizeButton, maximizeButton, closeButton);

  const version = document.createElement('span');
  version.className = 'zhixue-titlebar-version';
  version.textContent = '桌面版';
  brand.append(version);
  titleBar.append(brand, controls);
  document.body.prepend(titleBar);

  void ipcRenderer
    .invoke('setup:get-state')
    .then((state) => {
      if (state?.appVersion) version.textContent = `桌面版 v${state.appVersion}`;
    })
    .catch(() => {
      // The title bar remains usable even if version lookup is unavailable.
    });

  const updateMaximizeButton = (maximized) => {
    maximizeButton.innerHTML = maximized ? icons.restore : icons.maximize;
    maximizeButton.setAttribute('aria-label', maximized ? '向下还原' : '最大化');
    maximizeButton.title = maximized ? '向下还原' : '最大化';
  };
  titleBar.addEventListener('dblclick', (event) => {
    if (!event.target.closest('.zhixue-window-controls')) {
      ipcRenderer.send('window:control', 'maximize');
    }
  });
  ipcRenderer.on('window:maximized-changed', (_event, maximized) => {
    updateMaximizeButton(Boolean(maximized));
  });
  void ipcRenderer.invoke('window:is-maximized').then(updateMaximizeButton);
}

window.addEventListener('DOMContentLoaded', () => setTimeout(mountTitleBar, 0), { once: true });

contextBridge.exposeInMainWorld('zhixueDesktop', {
  openSettingsCenter: () => ipcRenderer.send('settings:open'),
  getSettingsCenterState: () => ipcRenderer.invoke('settings:get-state'),
  saveSettingsCenter: (input) => ipcRenderer.invoke('settings:save', input),
  reloadClassroom: () => ipcRenderer.invoke('settings:reload-classroom'),
  openAdvancedSettings: () => ipcRenderer.invoke('settings:open-advanced'),
  getSetupState: () => ipcRenderer.invoke('setup:get-state'),
  testConnection: (input) => ipcRenderer.invoke('setup:test-connection', input),
  saveSetup: (input) => ipcRenderer.invoke('setup:save', input),
  openDeepSeekConsole: () => ipcRenderer.invoke('setup:open-deepseek-console'),
  openDataDirectory: () => ipcRenderer.invoke('app:open-data'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  chooseRenderMode: () => ipcRenderer.invoke('app:render-mode'),
  clearTemporaryCache: () => ipcRenderer.invoke('app:clear-cache'),
  // One-way diagnostics channel: renderer logs land in the desktop log file.
  appendLog: (message) => ipcRenderer.send('app:log', String(message)),
});
