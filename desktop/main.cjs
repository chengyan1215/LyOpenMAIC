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
let settingsWindow;
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

/**
 * Find a free port deterministically-biased and OUTSIDE the Windows dynamic
 * (ephemeral) range. WinNAT / Hyper-V reserve shifting sub-ranges of 49152+ at
 * boot; a port chosen from that range can become un-bindable after a reboot,
 * which silently moves the app's origin and "loses" every course. Ports below
 * 49152 are never touched by those reservations. Walk a fixed low range so a
 * given install lands on the same port whenever possible.
 */
async function findFreePort() {
  const BASE = 39500;
  const END = 44999;
  for (let port = BASE; port <= END; port++) {
    if (await isPortAvailable(port)) return port;
  }
  // Extremely unlikely: the whole low range is busy. Last resort: let the OS
  // pick (may land in the ephemeral range, but this branch is theoretical).
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

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = nodeNet.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Stable origin for browser-side storage.
 *
 * Course documents, media bytes, and settings all live in the renderer's
 * IndexedDB / localStorage, which Chromium scopes to the FULL origin —
 * including the port. A port that changes on every launch therefore presents
 * a fresh empty origin each restart, and the user's generated courses
 * "disappear".
 *
 * Resolution order (deterministic-first):
 * 1. A previously recorded port under userData — reuse whenever still free.
 * 2. The fixed default port (DEFAULT_SERVER_PORT) — so even the very first
 *    launch is deterministic, not random. Recorded on success.
 * 3. Only if both are taken, pick a free port and record it. A later launch
 *    reuses that pick, so the origin stays stable from then on.
 */
const DEFAULT_SERVER_PORT = 45621;

async function resolveServerPort() {
  const portFile = path.join(app.getPath('userData'), 'server-port.json');
  const record = (port) => {
    try {
      fs.writeFileSync(portFile, JSON.stringify({ port }));
    } catch (error) {
      // Non-fatal: worst case the next launch resolves the port again.
      writeLog(`端口记录写入失败 port=${port}`, error);
    }
  };
  let saved = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(portFile, 'utf8')).port;
    if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) saved = parsed;
    if (saved && (await isPortAvailable(saved))) return saved;
  } catch {
    // First run or unreadable/corrupt file — fall through to the default port.
  }
  if (await isPortAvailable(DEFAULT_SERVER_PORT)) {
    if (saved) {
      // The origin is about to change — courses/settings stored under the old
      // port's origin become invisible. Make the cause findable in the log.
      writeLog(
        `端口已变更: ${saved} -> ${DEFAULT_SERVER_PORT}（旧端口不可绑定，origin 变化，旧 origin 下的课程将不可见）`,
      );
    }
    record(DEFAULT_SERVER_PORT);
    return DEFAULT_SERVER_PORT;
  }
  const port = await findFreePort();
  if (saved) {
    writeLog(
      `端口已变更: ${saved} -> ${port}（旧端口不可绑定，origin 变化，旧 origin 下的课程将不可见）`,
    );
  }
  record(port);
  return port;
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
    frame: false,
    backgroundColor: '#f7f7fb',
    autoHideMenuBar: true,
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
  bindWindowControls(mainWindow);
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

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: `${PRODUCT_NAME}设置中心`,
    frame: false,
    backgroundColor: '#f6f5fa',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  bindWindowControls(settingsWindow);
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => {
    settingsWindow = undefined;
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  void settingsWindow.loadFile(path.join(__dirname, 'settings-center', 'index.html'));
  return settingsWindow;
}

function bindWindowControls(window) {
  const notifyMaximizedState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send('window:maximized-changed', window.isMaximized());
    }
  };
  window.on('maximize', notifyMaximizedState);
  window.on('unmaximize', notifyMaximizedState);
}

function pingServer(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (response) => {
      response.resume();
      resolve((response.statusCode || 500) < 500);
    });
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
  // Pinned port — see resolveServerPort: a stable origin keeps the renderer's
  // IndexedDB/localStorage (courses, media, settings) alive across restarts.
  const port = await resolveServerPort();
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
      defaultId:
        modes.findIndex((m) => m.id === gpuRuntime.mode) >= 0
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
  let config = null;
  try {
    config = configStore.load();
  } catch (error) {
    writeLog('旧配置不可用，可进入设置中心重新配置', error);
  }
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
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter(Boolean)
      : [];
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

function emptyClassroomSettings() {
  return {
    theme: 'system',
    locale: 'zh-CN',
    recentClassroomsOpen: true,
    profile: {
      avatar: '/avatars/user.png',
      nickname: '',
      bio: '',
    },
    classroom: {
      ttsEnabled: true,
      asrEnabled: true,
      autoPlayLecture: false,
      playbackSpeed: 1,
      imageGenerationEnabled: false,
      videoGenerationEnabled: false,
      reviewOutlineEnabled: false,
    },
    provider: {
      id: '',
      name: '尚未配置',
      modelId: '',
      configuredCount: 0,
    },
  };
}

async function readClassroomSettings() {
  const fallback = emptyClassroomSettings();
  if (!mainWindow || mainWindow.isDestroyed() || !localUrl) return fallback;
  try {
    return await mainWindow.webContents.executeJavaScript(`(() => {
      const read = (key) => {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); }
        catch { return null; }
      };
      const profile = read('maic:account:user-profile-storage')?.state || {};
      const settings = read('maic:account:settings-storage')?.state || {};
      const providers = settings.providersConfig || {};
      const configured = Object.entries(providers).filter(([, item]) => {
        if (!item || item.serverDisabled) return false;
        if (item.isServerConfigured) return true;
        return item.requiresApiKey === false ? Boolean(item.baseUrl) : Boolean(item.apiKey);
      });
      const provider = providers[settings.providerId] || configured[0]?.[1] || null;
      const providerId = provider === providers[settings.providerId]
        ? (settings.providerId || '')
        : (configured[0]?.[0] || '');
      return {
        theme: ['light', 'dark', 'system'].includes(localStorage.getItem('theme'))
          ? localStorage.getItem('theme') : 'system',
        locale: localStorage.getItem('locale') || 'zh-CN',
        recentClassroomsOpen: localStorage.getItem('recentClassroomsOpen') !== 'false',
        profile: {
          avatar: typeof profile.avatar === 'string' ? profile.avatar : '/avatars/user.png',
          nickname: typeof profile.nickname === 'string' ? profile.nickname : '',
          bio: typeof profile.bio === 'string' ? profile.bio : '',
        },
        classroom: {
          ttsEnabled: settings.ttsEnabled !== false,
          asrEnabled: settings.asrEnabled !== false,
          autoPlayLecture: settings.autoPlayLecture === true,
          playbackSpeed: [1, 1.25, 1.5, 2].includes(settings.playbackSpeed)
            ? settings.playbackSpeed : 1,
          imageGenerationEnabled: settings.imageGenerationEnabled === true,
          videoGenerationEnabled: settings.videoGenerationEnabled === true,
          reviewOutlineEnabled: settings.reviewOutlineEnabled === true,
        },
        provider: {
          id: providerId,
          name: provider?.name || providerId || '尚未配置',
          modelId: settings.modelId || '',
          configuredCount: configured.length,
        },
      };
    })()`, true);
  } catch (error) {
    writeLog('读取课堂偏好失败', error);
    return fallback;
  }
}

function sanitizeSettingsUpdate(input) {
  const update = {};
  if (input?.general) {
    update.general = {
      theme: ['light', 'dark', 'system'].includes(input.general.theme)
        ? input.general.theme
        : 'system',
      locale: typeof input.general.locale === 'string' ? input.general.locale.slice(0, 16) : 'zh-CN',
      recentClassroomsOpen: input.general.recentClassroomsOpen !== false,
    };
  }
  if (input?.profile) {
    const avatar = String(input.profile.avatar || '/avatars/user.png');
    update.profile = {
      avatar: avatar.startsWith('/avatars/') || avatar.startsWith('data:image/')
        ? avatar.slice(0, 2_000_000)
        : '/avatars/user.png',
      nickname: String(input.profile.nickname || '').trim().slice(0, 40),
      bio: String(input.profile.bio || '').trim().slice(0, 500),
    };
  }
  if (input?.classroom) {
    const speed = Number(input.classroom.playbackSpeed);
    update.classroom = {
      ttsEnabled: input.classroom.ttsEnabled !== false,
      asrEnabled: input.classroom.asrEnabled !== false,
      autoPlayLecture: input.classroom.autoPlayLecture === true,
      playbackSpeed: [1, 1.25, 1.5, 2].includes(speed) ? speed : 1,
      imageGenerationEnabled: input.classroom.imageGenerationEnabled === true,
      videoGenerationEnabled: input.classroom.videoGenerationEnabled === true,
      reviewOutlineEnabled: input.classroom.reviewOutlineEnabled === true,
    };
  }
  return update;
}

async function saveClassroomSettings(input) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: '课堂窗口尚未就绪' };
  }
  const update = sanitizeSettingsUpdate(input);
  try {
    await mainWindow.webContents.executeJavaScript(`(() => {
      const update = ${JSON.stringify(update)};
      const read = (key) => {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); }
        catch { return null; }
      };
      if (update.general) {
        localStorage.setItem('theme', update.general.theme);
        localStorage.setItem('locale', update.general.locale);
        localStorage.setItem('recentClassroomsOpen', String(update.general.recentClassroomsOpen));
        const dark = update.general.theme === 'dark' ||
          (update.general.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('dark', dark);
      }
      if (update.profile) {
        const key = 'maic:account:user-profile-storage';
        const current = read(key) || {};
        localStorage.setItem(key, JSON.stringify({
          ...current,
          state: { ...(current.state || {}), ...update.profile },
        }));
      }
      if (update.classroom) {
        const key = 'maic:account:settings-storage';
        const current = read(key) || { version: 5 };
        localStorage.setItem(key, JSON.stringify({
          ...current,
          version: typeof current.version === 'number' ? current.version : 5,
          state: { ...(current.state || {}), ...update.classroom },
        }));
      }
      return true;
    })()`, true);
    return { ok: true, reloadRecommended: Boolean(update.profile || update.classroom || update.general?.locale) };
  } catch (error) {
    writeLog('保存课堂偏好失败', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function openAdvancedSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
  mainWindow.show();
  mainWindow.focus();
  try {
    const opened = await mainWindow.webContents.executeJavaScript(`(() => {
      const exact = document.querySelector(
        '[data-testid="pro-nav-settings"], [data-testid="pro-nav-settings-mini"]'
      );
      const iconButton = [...document.querySelectorAll('button')].find((button) =>
        !button.closest('#zhixue-desktop-titlebar') &&
        button.querySelector('svg.lucide-settings, svg[class*="lucide-settings"]')
      );
      const target = exact || iconButton;
      if (!target) return false;
      target.click();
      return true;
    })()`, true);
    return { ok: Boolean(opened) };
  } catch (error) {
    writeLog('打开原有详细设置失败', error);
    return { ok: false };
  }
}

function registerIpc() {
  ipcMain.on('window:control', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    if (action === 'close') window.close();
  });
  ipcMain.handle('window:is-maximized', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return Boolean(window && !window.isDestroyed() && window.isMaximized());
  });
  ipcMain.on('settings:open', () => createSettingsWindow());
  ipcMain.handle('settings:get-state', async () => ({
    desktop: {
      ...configStore.getPublicState(),
      appVersion: app.getVersion(),
      dataDirectory: app.getPath('userData'),
      gpuMode: gpuRuntime.mode,
      activeGpuMode,
      appUrl: localUrl,
    },
    classroom: await readClassroomSettings(),
  }));
  ipcMain.handle('settings:save', (_event, input) => saveClassroomSettings(input));
  ipcMain.handle('settings:reload-classroom', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    mainWindow.webContents.reload();
    return { ok: true };
  });
  ipcMain.handle('settings:open-advanced', () => openAdvancedSettings());
  ipcMain.handle('setup:get-state', () => ({
    ...configStore.getPublicState(),
    appVersion: app.getVersion(),
    dataDirectory: app.getPath('userData'),
    gpuMode: gpuRuntime.mode,
    activeGpuMode,
  }));
  ipcMain.handle('app:open-data', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:open-logs', () => shell.showItemInFolder(logFile));
  ipcMain.handle('app:render-mode', () => chooseRenderMode());
  ipcMain.handle('app:clear-cache', () => require('electron').session.defaultSession.clearCache());
  ipcMain.handle('setup:test-connection', (_event, input) => testDeepSeek(input, true));
  // Renderer-side diagnostics (TTS voice availability, playback warnings) land
  // in the same userData log file the desktop code writes to, so field issues
  // can be diagnosed from a customer's machine with a single file.
  ipcMain.on('app:log', (_event, message) => {
    writeLog(String(message).slice(0, 2000));
  });
  ipcMain.handle('setup:save', async (_event, input) => {
    try {
      configStore.save(input);
      setTimeout(async () => {
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
}

async function bootstrap() {
  app.setAppUserModelId('com.lyopenmaic.zhixue');
  logFile = path.join(app.getPath('userData'), 'zhixue-classroom.log');
  configStore = new ConfigStore(app.getPath('userData'));
  registerIpc();
  Menu.setApplicationMenu(null);
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
    copyright: '基于 OpenMAIC 开源项目的非官方桌面发行版',
  });

  try {
    await activateClassroom();
  } catch (error) {
    writeLog('应用启动失败', error);
    dialog.showErrorBox(`${PRODUCT_NAME}启动失败`, error.message || String(error));
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = mainWindow;
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
  if (mainWindow) return;
  void activateClassroom().catch((error) => {
    writeLog('应用启动失败', error);
    dialog.showErrorBox(PRODUCT_NAME + '启动失败', error.message || String(error));
  });
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
