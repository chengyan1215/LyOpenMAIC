'use strict';

const api = window.zhixueDesktop;
const avatarChoices = [
  '/avatars/user.png',
  '/avatars/teacher-2.png',
  '/avatars/assist-2.png',
  '/avatars/clown-2.png',
  '/avatars/curious-2.png',
  '/avatars/note-taker-2.png',
  '/avatars/thinker-2.png',
];

let snapshot;
let selectedAvatar = avatarChoices[0];
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setBusy(button, busy, busyText) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

function applyTheme(theme) {
  const dark = theme === 'dark' ||
    (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

function avatarUrl(value) {
  if (!value) return '';
  if (value.startsWith('data:')) return value;
  try { return new URL(value, snapshot?.desktop?.appUrl || 'http://127.0.0.1/').href; }
  catch { return value; }
}

function renderAvatars(current) {
  const values = avatarChoices.includes(current) ? avatarChoices : [current, ...avatarChoices];
  const container = $('#avatar-options');
  container.replaceChildren();
  values.filter(Boolean).forEach((value, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'avatar-button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', `选择头像 ${index + 1}`);
    const image = document.createElement('img');
    image.alt = '';
    image.src = avatarUrl(value);
    button.append(image);
    button.addEventListener('click', () => {
      selectedAvatar = value;
      $('#profile-avatar').src = avatarUrl(value);
      $$('.avatar-button').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-checked', String(selected));
      });
    });
    if (value === current) {
      button.classList.add('selected');
      button.setAttribute('aria-checked', 'true');
    } else {
      button.setAttribute('aria-checked', 'false');
    }
    container.append(button);
  });
}

function fillForms(data) {
  snapshot = data;
  const settings = data.classroom;
  const desktop = data.desktop;

  const theme = settings.theme || 'system';
  const themeInput = $(`input[name="theme"][value="${theme}"]`);
  if (themeInput) themeInput.checked = true;
  applyTheme(theme);
  $('#locale').value = settings.locale || 'zh-CN';
  $('#recent-classrooms').checked = settings.recentClassroomsOpen !== false;

  selectedAvatar = settings.profile.avatar || avatarChoices[0];
  $('#profile-avatar').src = avatarUrl(selectedAvatar);
  $('#nickname').value = settings.profile.nickname || '';
  $('#bio').value = settings.profile.bio || '';
  $('#profile-preview-name').textContent = settings.profile.nickname || '同学';
  renderAvatars(selectedAvatar);

  $('#tts-enabled').checked = settings.classroom.ttsEnabled;
  $('#asr-enabled').checked = settings.classroom.asrEnabled;
  $('#autoplay-enabled').checked = settings.classroom.autoPlayLecture;
  $('#playback-speed').value = String(settings.classroom.playbackSpeed);
  $('#image-enabled').checked = settings.classroom.imageGenerationEnabled;
  $('#video-enabled').checked = settings.classroom.videoGenerationEnabled;
  $('#review-enabled').checked = settings.classroom.reviewOutlineEnabled;

  const configured = desktop.configured || settings.provider.configuredCount > 0;
  $('#ai-status-label').textContent = desktop.configured
    ? '桌面安全连接'
    : '当前课堂默认服务';
  $('#ai-provider-name').textContent = desktop.configured
    ? 'DeepSeek'
    : settings.provider.name;
  $('#ai-model-name').textContent = desktop.model || settings.provider.modelId || '尚未选择模型';
  $('#ai-status-badge').textContent = configured ? '已配置' : '未配置';
  $('#ai-status-badge').className = `badge ${configured ? 'ok' : 'neutral'}`;
  $('#api-key').value = '';
  $('#api-key').placeholder = desktop.maskedApiKey || 'sk-…';
  $('#base-url').value = desktop.baseUrl || 'https://api.deepseek.com';
  $('#model').value = desktop.model || 'deepseek-v4-flash';

  $('#data-directory').textContent = desktop.dataDirectory || '—';
  const preferenceNames = { auto: '自动', hardware: '硬件加速', software: '软件渲染' };
  const activeNames = { hardware: '硬件加速', software: '软件渲染' };
  $('#gpu-mode').textContent = `${preferenceNames[desktop.gpuMode] || '自动'} · 当前 ${activeNames[desktop.activeGpuMode] || '未知'}`;
  $('#app-version').textContent = `桌面版 v${desktop.appVersion || '—'}`;
}

async function loadState() {
  try {
    fillForms(await api.getSettingsCenterState());
  } catch (error) {
    showToast(`设置读取失败：${error.message || error}`, true);
  }
}

async function saveSection(section, button) {
  const input = {};
  if (section === 'general') {
    const theme = $('input[name="theme"]:checked')?.value || 'system';
    input.general = {
      theme,
      locale: $('#locale').value,
      recentClassroomsOpen: $('#recent-classrooms').checked,
    };
    applyTheme(theme);
  }
  if (section === 'profile') {
    input.profile = {
      avatar: selectedAvatar,
      nickname: $('#nickname').value,
      bio: $('#bio').value,
    };
  }
  if (section === 'classroom') {
    input.classroom = {
      ttsEnabled: $('#tts-enabled').checked,
      asrEnabled: $('#asr-enabled').checked,
      autoPlayLecture: $('#autoplay-enabled').checked,
      playbackSpeed: Number($('#playback-speed').value),
      imageGenerationEnabled: $('#image-enabled').checked,
      videoGenerationEnabled: $('#video-enabled').checked,
      reviewOutlineEnabled: $('#review-enabled').checked,
    };
  }
  setBusy(button, true, '保存中…');
  try {
    const result = await api.saveSettingsCenter(input);
    if (!result?.ok) throw new Error(result?.error || '保存失败');
    showToast(result.reloadRecommended ? '已保存，刷新课堂页后完整生效' : '已保存');
    await loadState();
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function connectionInput() {
  const desktop = snapshot?.desktop || {};
  return {
    apiKey: $('#api-key').value.trim(),
    baseUrl: $('#base-url').value.trim(),
    model: $('#model').value,
    usageScene: desktop.usageScene || 'self-study',
    knowledgeLevel: desktop.knowledgeLevel || 'beginner',
  };
}

async function testConnection() {
  const button = $('#test-connection');
  const resultNode = $('#connection-result');
  setBusy(button, true, '检测中…');
  resultNode.className = 'inline-status';
  resultNode.textContent = '正在连接 DeepSeek…';
  try {
    const result = await api.testConnection(await connectionInput());
    if (!result?.ok) throw new Error(result?.error || '连接失败');
    resultNode.className = 'inline-status ok';
    resultNode.textContent = `连接成功，可使用 ${result.model}`;
  } catch (error) {
    resultNode.className = 'inline-status error';
    resultNode.textContent = error.message || String(error);
  } finally {
    setBusy(button, false);
  }
}

async function saveConnection() {
  const button = $('#save-connection');
  const resultNode = $('#connection-result');
  setBusy(button, true, '保存中…');
  resultNode.className = 'inline-status';
  try {
    const result = await api.saveSetup(await connectionInput());
    if (!result?.ok) throw new Error(result?.error || '保存失败');
    resultNode.className = 'inline-status ok';
    resultNode.textContent = '连接已安全保存，课堂服务正在重新载入。';
    showToast('AI 服务连接已保存');
    setTimeout(loadState, 900);
  } catch (error) {
    resultNode.className = 'inline-status error';
    resultNode.textContent = error.message || String(error);
  } finally {
    setBusy(button, false);
  }
}

$$('.nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
    $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === button.dataset.section));
    $('.content').scrollTop = 0;
  });
});

$$('[data-save]').forEach((button) =>
  button.addEventListener('click', () => saveSection(button.dataset.save, button)),
);
$('input[name="theme"][value="light"]').addEventListener('change', () => applyTheme('light'));
$('input[name="theme"][value="dark"]').addEventListener('change', () => applyTheme('dark'));
$('input[name="theme"][value="system"]').addEventListener('change', () => applyTheme('system'));
$('#nickname').addEventListener('input', (event) => {
  $('#profile-preview-name').textContent = event.target.value.trim() || '同学';
});
$('#test-connection').addEventListener('click', testConnection);
$('#save-connection').addEventListener('click', saveConnection);
$('#open-advanced').addEventListener('click', async () => {
  const result = await api.openAdvancedSettings();
  if (!result?.ok) showToast('当前页面没有找到详细设置入口', true);
});
$('#open-data').addEventListener('click', () => api.openDataDirectory());
$('#open-logs').addEventListener('click', () => api.openLogs());
$('#choose-render-mode').addEventListener('click', () => api.chooseRenderMode());
$('#clear-cache').addEventListener('click', async () => {
  await api.clearTemporaryCache();
  showToast('临时缓存已清理');
});
$('#reload-classroom').addEventListener('click', async () => {
  await api.reloadClassroom();
  showToast('课堂页正在刷新');
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ($('input[name="theme"]:checked')?.value === 'system') applyTheme('system');
});

void loadState();
