'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { maskApiKey, validateSetupInput } = require('./config-core.cjs');

const CONFIG_VERSION = 1;

class ConfigStore {
  constructor(userDataDirectory) {
    this.filePath = path.join(userDataDirectory, 'desktop-settings.json');
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  readRaw() {
    if (!this.exists()) return null;
    const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (value?.version !== CONFIG_VERSION || typeof value.encryptedApiKey !== 'string') {
      throw new Error('配置文件版本不受支持');
    }
    return value;
  }

  load() {
    const value = this.readRaw();
    if (!value) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储尚未可用');
    }
    const apiKey = safeStorage.decryptString(Buffer.from(value.encryptedApiKey, 'base64'));
    return validateSetupInput({ ...value, apiKey });
  }

  getPublicState() {
    try {
      const config = this.load();
      if (!config) return { configured: false };
      return {
        configured: true,
        baseUrl: config.baseUrl,
        model: config.model,
        usageScene: config.usageScene,
        knowledgeLevel: config.knowledgeLevel,
        maskedApiKey: maskApiKey(config.apiKey),
      };
    } catch (error) {
      return {
        configured: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  save(input) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('无法启用 Windows 安全存储，请退出软件后重试');
    }

    // A newly supplied key is sufficient to replace even a corrupt/legacy
    // config. Only decrypt the existing value when the user intentionally
    // leaves the key field blank.
    const existing = input.apiKey ? null : this.load();
    const normalized = validateSetupInput(
      { ...input, apiKey: input.apiKey || existing?.apiKey || '' },
      { allowEmptyApiKey: false },
    );
    const encryptedApiKey = safeStorage.encryptString(normalized.apiKey).toString('base64');
    const serializable = {
      version: CONFIG_VERSION,
      provider: 'deepseek',
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      usageScene: normalized.usageScene,
      knowledgeLevel: normalized.knowledgeLevel,
      encryptedApiKey,
      updatedAt: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(serializable, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, this.filePath);
    return normalized;
  }
}

module.exports = { ConfigStore };
