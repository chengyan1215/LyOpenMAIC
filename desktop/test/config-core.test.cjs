'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createServerEnvironment,
  maskApiKey,
  normalizeBaseUrl,
  redactSecrets,
  validateSetupInput,
} = require('../lib/config-core.cjs');

test('normalizes the DeepSeek base URL', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.throws(() => normalizeBaseUrl('file:///tmp/key'), /http/);
});

test('validates and normalizes setup input', () => {
  const value = validateSetupInput({ apiKey: ' sk-test ', model: 'deepseek-v4-flash' });
  assert.equal(value.apiKey, 'sk-test');
  assert.equal(value.usageScene, 'self-study');
  assert.throws(() => validateSetupInput({ apiKey: 'x', model: 'unknown-model' }), /模型/);
});

test('creates the managed server environment', () => {
  const env = createServerEnvironment({
    apiKey: 'secret',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  });
  assert.equal(env.DEFAULT_MODEL, 'deepseek:deepseek-v4-flash');
  assert.equal(env.DEEPSEEK_MODELS, 'deepseek-v4-flash');
  assert.equal(env.NEXT_PUBLIC_MAIC_EDITOR_ENABLED, '1');
});

test('starts without AI credentials on a fresh installation', () => {
  for (const config of [null, undefined]) {
    assert.deepEqual(createServerEnvironment(config), {
      NEXT_PUBLIC_MAIC_EDITOR_ENABLED: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    });
  }
});

test('masks and redacts secrets', () => {
  assert.equal(maskApiKey('1234567890abcdef'), '1234••••••••cdef');
  assert.equal(
    redactSecrets('key=abc Bearer token-123', ['abc']),
    'key=[REDACTED] Bearer [REDACTED]',
  );
});
