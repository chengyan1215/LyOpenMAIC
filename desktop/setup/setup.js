'use strict';

const form = document.querySelector('#setup-form');
const apiKeyInput = document.querySelector('#api-key');
const baseUrlInput = document.querySelector('#base-url');
const modelInput = document.querySelector('#model');
const testButton = document.querySelector('#test-button');
const saveButton = document.querySelector('#save-button');
const cancelButton = document.querySelector('#cancel-button');
const toggleKeyButton = document.querySelector('#toggle-key');
const statusBox = document.querySelector('#status');

let configured = false;
let busy = false;

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function selectRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function payload() {
  return {
    apiKey: apiKeyInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
    model: modelInput.value,
    usageScene: selectedValue('usageScene'),
    knowledgeLevel: selectedValue('knowledgeLevel'),
  };
}

function setBusy(value, label) {
  busy = value;
  testButton.disabled = value;
  saveButton.disabled = value;
  saveButton.textContent = value ? label || '正在处理…' : '保存并进入智学课堂';
}

function showStatus(type, message) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = message;
}

function clearStatus() {
  statusBox.className = 'status';
  statusBox.textContent = '';
}

async function testConnection() {
  if (busy) return false;
  clearStatus();
  if (!apiKeyInput.value.trim() && !configured) {
    showStatus('error', '请先填写 DeepSeek API Key。');
    apiKeyInput.focus();
    return false;
  }
  setBusy(true, '正在测试…');
  showStatus('loading', '正在连接 DeepSeek，通常只需几秒…');
  const result = await window.zhixueDesktop.testConnection(payload());
  setBusy(false);
  if (result.ok) {
    showStatus('success', `连接成功，模型 ${result.model} 可用。`);
    return true;
  }
  showStatus('error', result.error || '连接失败，请检查 Key 和网络。');
  return false;
}

async function save(event) {
  event.preventDefault();
  if (busy) return;
  clearStatus();
  if (!apiKeyInput.value.trim() && !configured) {
    showStatus('error', '请先填写 DeepSeek API Key。');
    apiKeyInput.focus();
    return;
  }
  setBusy(true, '正在验证并保存…');
  showStatus('loading', '正在验证配置…');
  const result = await window.zhixueDesktop.saveSetup(payload());
  if (!result.ok) {
    setBusy(false);
    showStatus('error', result.error || '保存失败，请重试。');
    return;
  }
  showStatus('success', '设置已安全保存，正在启动智学课堂…');
}

async function initialize() {
  const state = await window.zhixueDesktop.getSetupState();
  configured = Boolean(state.configured);
  document.querySelector('#version').textContent = `v${state.appVersion} · 非官方 OpenMAIC 桌面发行版`;
  if (configured) {
    document.querySelector('#page-title').textContent = '调整 DeepSeek 与使用设置';
    document.querySelector('#page-description').textContent = '保存后会自动重启本地课堂服务，已保存的课程不受影响。';
    apiKeyInput.placeholder = `已保存 ${state.maskedApiKey}（留空表示不修改）`;
    document.querySelector('#key-hint').textContent = `已加密保存 ${state.maskedApiKey}；如不更换 Key，请留空。`;
    baseUrlInput.value = state.baseUrl;
    modelInput.value = state.model;
    selectRadio('usageScene', state.usageScene);
    selectRadio('knowledgeLevel', state.knowledgeLevel);
  } else if (state.error) {
    showStatus('error', `旧配置无法读取：${state.error}。请重新填写。`);
  }
  cancelButton.hidden = state.mode === 'first-run';
}

form.addEventListener('submit', save);
testButton.addEventListener('click', testConnection);
cancelButton.addEventListener('click', () => window.zhixueDesktop.closeSetup());
document.querySelector('#open-console').addEventListener('click', () =>
  window.zhixueDesktop.openDeepSeekConsole(),
);
toggleKeyButton.addEventListener('click', () => {
  const reveal = apiKeyInput.type === 'password';
  apiKeyInput.type = reveal ? 'text' : 'password';
  toggleKeyButton.textContent = reveal ? '隐藏' : '显示';
});

initialize().catch((error) => showStatus('error', `设置页加载失败：${error.message || error}`));
