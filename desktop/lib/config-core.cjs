'use strict';

const PRODUCT_NAME = '智学课堂';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const ALLOWED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const ALLOWED_SCENES = new Set(['self-study', 'family', 'teaching', 'career', 'other']);
const ALLOWED_LEVELS = new Set(['beginner', 'intermediate', 'advanced']);

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('API 地址格式不正确');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('API 地址必须以 http:// 或 https:// 开头');
  }
  return parsed.toString().replace(/\/$/, '');
}

function validateSetupInput(input, options = {}) {
  const apiKey = String(input?.apiKey || '').trim();
  if (!apiKey && !options.allowEmptyApiKey) {
    throw new Error('请填写 DeepSeek API Key');
  }

  const model = String(input?.model || DEFAULT_MODEL).trim();
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error('请选择支持的 DeepSeek 模型');
  }

  const usageScene = ALLOWED_SCENES.has(input?.usageScene) ? input.usageScene : 'self-study';
  const knowledgeLevel = ALLOWED_LEVELS.has(input?.knowledgeLevel)
    ? input.knowledgeLevel
    : 'beginner';

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(input?.baseUrl),
    model,
    usageScene,
    knowledgeLevel,
  };
}

function maskApiKey(apiKey) {
  const value = String(apiKey || '');
  if (!value) return '';
  if (value.length < 9) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

function redactSecrets(text, secrets = []) {
  let result = String(text || '');
  for (const secret of secrets) {
    if (secret) result = result.split(String(secret)).join('[REDACTED]');
  }
  return result.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
}

function createServerEnvironment(config) {
  return {
    DEEPSEEK_API_KEY: config.apiKey,
    DEEPSEEK_BASE_URL: config.baseUrl,
    DEEPSEEK_MODELS: config.model,
    DEFAULT_MODEL: `deepseek:${config.model}`,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

module.exports = {
  ALLOWED_MODELS,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  PRODUCT_NAME,
  createServerEnvironment,
  maskApiKey,
  normalizeBaseUrl,
  redactSecrets,
  validateSetupInput,
};
