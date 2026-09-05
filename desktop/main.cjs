'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, net: electronNet, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const nodeNet = require('node:net');
const path = require('node:path');
const { ConfigStore } = require('./lib/config-store.cjs');
const {
  PRODUCT_NAME,
  createServerEnvironment,
  redactSecrets,
  validateSetupInput,
} = require('./lib/config-core.cjs');

app.setName(PRODUCT_NAME);

/**
 * GPU rendering mode.
 *
 * 'hardware': stock Chromium compositing — fast, uses the customer's GPU.
 * 'software': disableHardwareAcceleration + disable-gpu + in-process-gpu, the
 *             historical compatibility mode for Boot Camp / stripped Windows
 *             images whose GPU-process dependencies are missing.
 *
 * mode resolution order: explicit user preference > crash heuristics.
 * In 'auto' we try hardware and fall back to software when the previous
 * hardware run died uncleanly or the GPU child process keeps crashing. The
 * launch marker is written BEFORE app.whenReady() so even a hard crash at GPU
 * init leaves a trace that the next launch can act on.
 */
const { loadGpuState, saveGpuState } = require('./lib/gpu-state.cjs');

const gpuUserDataDirectory = app.getPath('userData');
const gpuRuntime = loadGpuState(gpuUserDataDirectory);

function resolveGpuMode(state) {
  if (state.mode === 'hardware') return 'hardware';
  if (state.mode === 'software') return 'software';
  if (state.lastLaunchGpuMode === 'hardware' && !state.lastLaunchClean) return 'software';
  if (state.failures >= 2) return 'software';
  return 'hardware';
}

const activeGpuMode = resolveGpuMode(gpuRuntime);
if (activeGpuMode === 'software') {
  app.disableHardwareAcceleration();
  // On a few Boot Camp / stripped-down Windows images Chromium still tries to
  // launch a separate GPU child even with acceleration disabled. Keeping that
  // work in-process avoids the missing GPU-child DLL failure on first launch.
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
}

// Record the attempted mode immediately: if this run crashes hard at GPU
// initialization, the unclean marker makes the next launch fall back to
// software rendering automatically.
gpuRuntime.lastLaunchGpuMode = activeGpuMode;
gpuRuntime.lastLaunchClean = false;
saveGpuState(gpuUserDataDirectory, gpuRuntime);

let gpuCrashedThisSession = false;

app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return;
  gpuCrashedThisSession = true;
  gpuRuntime.failures += 1;
  writeLog(`GPU 进程异常 reason=${details.reason} failures=${gpuRuntime.failures}`);
  if (gpuRuntime.mode === 'auto' && gpuRuntime.failures >= 2 && activeGpuMode === 'hardware') {
    gpuRuntime.mode = 'software';
    writeLog('GPU 进程反复崩溃，已自动切换为软件渲染，重启后完全生效');
    saveGpuState(gpuUserDataDirectory, gpuRuntime);
  } else {
    saveGpuState(gpuUserDataDirectory, gpuRuntime);
  }
});

let configStore;
let logFile;
let mainWindow;
let setupWindow;
let serverProcess;
let localUrl;
let quitting = false;
const plannedServerStops = new Set();

function writeLog(message, error) {
  const secrets = [];
  try {
    secrets.push(configStore?.load()?.apiKey);
  } catch {
    // A broken config must not prevent logging the actual startup error.
  }
  const details = error
    ? ` ${error instanceof Error ? error.stack || error.message : String(error)}`
    : '';
  const line = `[${new Date().toISOString()}] ${redactSecrets(`${message}${details}`, secrets)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    // Logging is best effort; the UI still reports fatal errors.
  }
  if (!app.isPackaged) process.stdout.write(line);
}

function loadingPage() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:#f7f7fb;color:#24212d;font-family:system-ui,"Microsoft YaHei",sans-serif}
.box{text-align:center}.mark{width:64px;height:64px;margin:0 auto 22px;display:grid;place-items:center;border-radius:20px;background:linear-gradient(135deg,#7157ff,#a855f7);color:white;font-size:30px;font-weight:800;box-shadow:0 16px 40px #7657ff45}
h1{font-size:24px;margin:0 0 10px}p{margin:0;color:#777182}.dots:after{content:'...';display:inline-block;width:20px;text-align:left;animation:d 1.3s steps(4,end) infinite}@keyframes d{0%{clip-path:inset(0 100% 0 0)}100%{clip-path:inset(0 0 0 0)}}
</style></head><body><div class="box"><div class="mark">智</div><h1>${PRODUCT_NAME}</h1><p>正在启动本地课堂服务<span class="dots"></span></p></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配本地端口'))));
    });
  });
}

function getRuntimeDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'standalone')
    : path.resolve(__dirname, '..');
}

function getPackagedServerEntry(runtimeDirectory) {
  const manifestPath = path.join(runtimeDirectory, 'desktop-runtime.json');
  if (!fs.existsSync(manifestPath)) return path.join(runtimeDirectory, 'server.js');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.serverRelativePath !== 'string') {
    throw new Error('桌面运行时清单无效');
  }
  const resolved = path.resolve(runtimeDirectory, manifest.serverRelativePath);
  const relative = path.relative(runtimeDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('桌面运行时入口越界');
  }
  return resolved;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: '#f7f7fb',
    autoHideMenuBar: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the renderer isolated from Node, but avoid Chromium's OS sandbox
      // for compatibility with stripped-down and Boot Camp Windows installs.
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (localUrl && url.startsWith(localUrl)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (localUrl && url.startsWith(localUrl)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  void mainWindow.loadURL(loadingPage());
  return mainWindow;
}

function installMenu() {
  const template = [
    {
      label: '设置',
      submenu: [
        {
          label: 'DeepSeek 与使用设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => showSetupWindow('settings'),
        },
        { type: 'separator' },
        {
          label: '打开日志位置',
          click: () => shell.showItemInFolder(logFile),
        },
        { type: 'separator' },
        {
          label: '渲染模式…',
          click: () => chooseRenderMode(),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '页面',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '获取 DeepSeek API Key',
          click: () => shell.openExternal('https://platform.deepseek.com/api_keys'),
        },
        {
          label: '项目与开源许可',
          click: () => shell.openExternal('https://github.com/chengyan1215/LyOpenMAIC'),
        },
        { type: 'separator' },
        {
          label: `关于 ${PRODUCT_NAME}`,
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: `关于 ${PRODUCT_NAME}`,
              message: `${PRODUCT_NAME} ${app.getVersion()}`,
              detail:
                '基于清华大学 OpenMAIC 开源项目适配的非官方桌面发行版。\nOpenMAIC 按 MIT 许可证开源。',
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function pingServer(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: 2500 },
      (response) => {
        response.resume();
        resolve((response.statusCode || 500) < 500);
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForServer(port, timeoutMs = app.isPackaged ? 90000 : 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingServer(port)) return true;
    if (!serverProcess || serverProcess.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function stopServer() {
  return new Promise((resolve) => {
    const child = serverProcess;
    serverProcess = undefined;
    if (!child || child.exitCode !== null) return resolve();
    plannedServerStops.add(child.pid);
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('exit', () => {
        resolve();
      });
      killer.once('error', () => {
        resolve();
      });
    } else {
      child.kill('SIGTERM');
      child.once('exit', () => {
        resolve();
      });
      setTimeout(resolve, 3000).unref();
    }
  });
}

async function startServer(config) {
  const port = await findFreePort();
  localUrl = `http://127.0.0.1:${port}`;
  const runtimeDirectory = getRuntimeDirectory();
  const environment = {
    ...process.env,
    ...createServerEnvironment(config),
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    NODE_ENV: app.isPackaged ? 'production' : 'development',
  };

  let executable;
  let args;
  if (app.isPackaged) {
    const serverEntry = getPackagedServerEntry(runtimeDirectory);
    if (!fs.existsSync(serverEntry)) throw new Error(`缺少运行文件：${serverEntry}`);
    executable = process.execPath;
    args = [serverEntry];
    environment.HOSTNAME = '127.0.0.1';
    environment.ELECTRON_RUN_AS_NODE = '1';
    environment.NEXT_PRIVATE_STANDALONE = 'true';
    environment.PWD = path.dirname(serverEntry);
  } else {
    const nextEntry = path.join(runtimeDirectory, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (!fs.existsSync(nextEntry)) {
      throw new Error('尚未安装项目依赖，请先运行 pnpm install');
    }
    executable = process.execPath;
    args = [nextEntry, 'dev', '-H', '127.0.0.1', '-p', String(port)];
    environment.ELECTRON_RUN_AS_NODE = '1';
  }

  serverProcess = spawn(executable, args, {
    cwd: app.isPackaged ? path.dirname(getPackagedServerEntry(runtimeDirectory)) : runtimeDirectory,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = serverProcess;
  writeLog(`课堂服务启动 pid=${child.pid} url=${localUrl}`);
  child.stdout.on('data', (data) => writeLog(`[server] ${String(data).trimEnd()}`));
  child.stderr.on('data', (data) => writeLog(`[server:error] ${String(data).trimEnd()}`));
  child.once('error', (error) => writeLog('课堂服务无法启动', error));
  child.once('exit', (code) => {
    writeLog(`课堂服务退出 code=${code}`);
    if (serverProcess === child) serverProcess = undefined;
    const wasPlanned = plannedServerStops.delete(child.pid);
    if (!quitting && !wasPlanned) {
      dialog.showErrorBox(
        `${PRODUCT_NAME}运行异常`,
        `后台服务已退出。请重新启动软件。\n\n日志位置：\n${logFile}`,
      );
    }
  });
  return { port, url: localUrl };
}

function chooseRenderMode() {
  const modes = [
    { id: 'auto', label: '自动（推荐）' },
    { id: 'hardware', label: '硬件加速（性能优先）' },
    { id: 'software', label: '软件渲染（兼容模式）' },
  ];
  const detail =
    `当前生效：${activeGpuMode === 'hardware' ? '硬件加速' : '软件渲染'}\n` +
    `当前偏好：${modes.find((m) => m.id === gpuRuntime.mode)?.label || '自动'}\n\n` +
    '自动模式下软件会优先尝试硬件加速，检测到显卡异常时自动降级为软件渲染。';
  void dialog
    .showMessageBox({
      type: 'question',
      title: `渲染模式 - ${PRODUCT_NAME}`,
      message: '选择图形渲染模式',
      detail,
      buttons: [...modes.map((m) => m.label), '取消'],
      cancelId: modes.length,
      defaultId: modes.findIndex((m) => m.id === gpuRuntime.mode) >= 0
        ? modes.findIndex((m) => m.id === gpuRuntime.mode)
        : 0,
    })
    .then(({ response }) => {
      if (response < 0 || response >= modes.length) return;
      const selected = modes[response].id;
      if (selected === gpuRuntime.mode) return;
      gpuRuntime.mode = selected;
      saveGpuState(gpuUserDataDirectory, gpuRuntime);
      writeLog(`渲染模式偏好已切换为 ${selected}`);
      void dialog
        .showMessageBox({
          type: 'info',
          title: '需要重启',
          message: '渲染模式将在重启应用后生效，现在重启吗？',
          buttons: ['立即重启', '稍后手动重启'],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response: restart }) => {
          if (restart !== 0) return;
          app.relaunch();
          app.quit();
        });
    });
}

async function activateClassroom() {
  const config = configStore.load();
  if (!config) return showSetupWindow('first-run');
  const win = createMainWindow();
  await win.loadURL(loadingPage());
  win.show();
  await stopServer();
  const { port, url } = await startServer(config);
  const ready = await waitForServer(port);
  if (!ready) {
    throw new Error(`本地服务未能在限定时间内启动。请查看日志：${logFile}`);
  }
  writeLog('课堂服务已就绪');
  await win.loadURL(url);
  win.show();
  win.focus();
}

function showSetupWindow(mode = 'settings') {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 840,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    show: false,
    resizable: true,
    title: mode === 'first-run' ? `欢迎使用${PRODUCT_NAME}` : `${PRODUCT_NAME}设置`,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // See the compatibility note in the main window configuration above.
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [`--zhixue-setup-mode=${mode}`],
    },
  });
  setupWindow.once('ready-to-show', () => setupWindow?.show());
  setupWindow.on('closed', () => {
    setupWindow = undefined;
    if (!mainWindow && !configStore.getPublicState().configured) app.quit();
  });
  void setupWindow.loadFile(path.join(__dirname, 'setup', 'index.html'));
}

function friendlyDeepSeekError(error, status) {
  if (status === 401 || status === 403) return 'API Key 无效或已过期';
  if (status === 402) return 'DeepSeek 账户余额不足';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status && status >= 500) return 'DeepSeek 服务暂时不可用';
  const message = error instanceof Error ? error.message : String(error || '');
  if (/abort|timeout/i.test(message)) return '连接超时，请检查网络或代理设置';
  return message || '无法连接 DeepSeek';
}

async function testDeepSeek(input, useStoredKey = false) {
  let normalized;
  try {
    const existing = !input?.apiKey && useStoredKey ? configStore.load() : null;
    normalized = validateSetupInput({
      ...existing,
      ...input,
      apiKey: input?.apiKey || existing?.apiKey || '',
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await electronNet.fetch(`${normalized.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${normalized.apiKey}` },
      signal: controller.signal,
      bypassCustomProtocolHandlers: true,
    });
    if (!response.ok) {
      const details = redactSecrets(await response.text(), [normalized.apiKey]);
      writeLog(`DeepSeek 检测失败 status=${response.status} ${details.slice(0, 500)}`);
      throw Object.assign(new Error(friendlyDeepSeekError(null, response.status)), {
        publicMessage: friendlyDeepSeekError(null, response.status),
      });
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id).filter(Boolean) : [];
    if (models.length && !models.includes(normalized.model)) {
      throw Object.assign(new Error(`当前账户不可用模型 ${normalized.model}`), {
        publicMessage: `当前账户不可用模型 ${normalized.model}`,
      });
    }
    return { ok: true, model: normalized.model };
  } catch (error) {
    const publicMessage = error?.publicMessage || friendlyDeepSeekError(error, response?.status);
    return { ok: false, error: publicMessage };
  } finally {
    clearTimeout(timer);
  }
}

function registerIpc() {
  ipcMain.handle('setup:get-state', (event) => ({
    ...configStore.getPublicState(),
    mode:
      event.sender.getLastWebPreferences()?.additionalArguments?.find((arg) =>
        arg.startsWith('--zhixue-setup-mode='),
      )?.split('=')[1] || 'settings',
    appVersion: app.getVersion(),
  }));
  ipcMain.handle('setup:test-connection', (_event, input) => testDeepSeek(input, true));
  ipcMain.handle('setup:save', async (_event, input) => {
    const result = await testDeepSeek(input, true);
    if (!result.ok) return result;
    try {
      configStore.save(input);
      setTimeout(async () => {
        setupWindow?.close();
        try {
          await activateClassroom();
        } catch (error) {
          writeLog('应用启动失败', error);
          dialog.showErrorBox(`${PRODUCT_NAME}启动失败`, error.message || String(error));
        }
      }, 100);
      return { ok: true };
    } catch (error) {
      writeLog('保存设置失败', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('setup:open-deepseek-console', () =>
    shell.openExternal('https://platform.deepseek.com/api_keys'),
  );
  ipcMain.handle('setup:close', () => setupWindow?.close());
}

async function bootstrap() {
  app.setAppUserModelId('com.lyopenmaic.zhixue');
  logFile = path.join(app.getPath('userData'), 'zhixue-classroom.log');
  configStore = new ConfigStore(app.getPath('userData'));
  registerIpc();
  installMenu();
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
    copyright: '基于 OpenMAIC 开源项目的非官方桌面发行版',
  });

  const state = configStore.getPublicState();
  if (!state.configured) {
    if (state.error) writeLog(`配置不可用：${state.error}`);
    showSetupWindow('first-run');
    return;
  }
  try {
    await activateClassroom();
  } catch (error) {
    writeLog('应用启动失败', error);
    dialog.showErrorBox(`${PRODUCT_NAME}启动失败`, error.message || String(error));
    showSetupWindow('settings');
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = setupWindow || mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.whenReady().then(() => {
    sessionPermissions();
    return bootstrap();
  });
}

function sessionPermissions() {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    let origin;
    try {
      origin = new URL(webContents.getURL()).origin;
    } catch {
      origin = '';
    }
    const isLocal = origin.startsWith('http://127.0.0.1:');
    callback(isLocal && ['media', 'microphone', 'audioCapture'].includes(permission));
  });
}

app.on('activate', () => {
  if (setupWindow || mainWindow) return;
  if (configStore?.exists()) void activateClassroom();
  else showSetupWindow('first-run');
});
app.on('before-quit', () => {
  quitting = true;
  // Mark the run as clean so the auto GPU heuristic can trust hardware mode.
  // A hardware session that ends without any GPU crash also forgives earlier
  // failures, so a one-off glitch never permanently downgrades rendering.
  gpuRuntime.lastLaunchClean = true;
  if (activeGpuMode === 'hardware' && !gpuCrashedThisSession) {
    gpuRuntime.failures = 0;
  }
  saveGpuState(gpuUserDataDirectory, gpuRuntime);
});
app.on('will-quit', () => {
  void stopServer();
});
app.on('window-all-closed', () => app.quit());
