import { _electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const upstream = process.env.SETTINGS_TEST_UPSTREAM || 'http://127.0.0.1:3002';
const upstreamResponse = await fetch(upstream, { signal: AbortSignal.timeout(15000) });
if (!upstreamResponse.ok) throw new Error(`Development server is unavailable: ${upstream}`);

const output = path.join(root, 'e2e/screenshots/settings-center');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(output, 'isolated-'));
const testEnvironment = { ...process.env, SETTINGS_TEST_DATA: userData, SETTINGS_TEST_UPSTREAM: upstream };
delete testEnvironment.ELECTRON_RUN_AS_NODE;

const app = await _electron.launch({
  executablePath: require('electron'),
  args: [path.join(root, 'desktop/test-fixtures/settings-entry.cjs')],
  env: testEnvironment,
  timeout: 90000,
});

const failures = [];
try {
  const classroom = await app.firstWindow();
  classroom.on('pageerror', (error) => failures.push(`classroom: ${error.message}`));
  await classroom.waitForURL('http://127.0.0.1:*/**', { timeout: 90000 });
  await expect(classroom.locator('#zhixue-desktop-titlebar')).toBeVisible({ timeout: 60000 });
  expect(await classroom.evaluate(() => window.zhixueDesktop.getSetupState())).toMatchObject({ configured: false });

  await classroom.getByRole('button', { name: '设置', exact: true }).click();
  await expect.poll(() => app.windows().length).toBe(2);
  const settings = app.windows().find((page) => page !== classroom);
  if (!settings) throw new Error('Settings window did not open');
  await settings.waitForURL('file:**');
  settings.on('pageerror', (error) => failures.push(`settings: ${error.message}`));
  await expect(settings.getByRole('heading', { name: '通用', exact: true })).toBeVisible();
  await settings.screenshot({ path: path.join(output, 'desktop-general.png') });

  await settings.getByRole('button', { name: /学习档案/ }).click();
  await settings.getByLabel('如何称呼你').fill('桌面设置测试');
  await settings.getByLabel('自我介绍').fill('喜欢用具体案例理解新知识。');
  await settings.getByRole('radio', { name: '选择头像 3', exact: true }).click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('已保存');
  await expect.poll(() => classroom.evaluate(() => {
    const raw = localStorage.getItem('maic:account:user-profile-storage');
    return raw ? JSON.parse(raw).state?.nickname : '';
  })).toBe('桌面设置测试');
  await settings.screenshot({ path: path.join(output, 'desktop-profile.png') });

  await settings.getByRole('button', { name: /通用/ }).click();
  await settings.getByRole('radio', { name: '深色', exact: true }).check({ force: true });
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await expect(settings.locator('html')).toHaveClass(/dark/);
  await expect.poll(() => classroom.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  await expect(classroom.locator('html')).toHaveClass(/dark/);
  await settings.screenshot({ path: path.join(output, 'desktop-general-dark.png') });

  await settings.getByRole('button', { name: /课堂与能力/ }).click();
  await settings.getByLabel('图片生成').check({ force: true });
  await settings.getByLabel('进入课堂后自动播放').check({ force: true });
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => classroom.evaluate(() => {
    const raw = localStorage.getItem('maic:account:settings-storage');
    const state = raw ? JSON.parse(raw).state : {};
    return [state?.imageGenerationEnabled, state?.autoPlayLecture];
  })).toEqual([true, true]);

  await settings.getByRole('button', { name: /AI 服务/ }).click();
  await expect(settings.getByRole('heading', { name: '桌面版 DeepSeek 连接' })).toBeVisible();
  await expect(settings.locator('#ai-status-badge')).toHaveText(/^(未配置|已配置)$/);

  await settings.locator('#open-advanced').click();
  await expect(classroom.getByRole('dialog')).toBeVisible();
  await classroom.keyboard.press('Escape');
  await expect(classroom.getByRole('dialog')).toBeHidden();
  await classroom.getByRole('button', { name: '设置', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'AI 服务', exact: true })).toBeVisible();

  await settings.getByRole('button', { name: /存储与运行/ }).click();
  await expect(settings.getByRole('button', { name: '清理缓存', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '刷新课堂页', exact: true })).toBeVisible();

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('file:'));
    win?.setSize(900, 620);
  });
  await expect(settings.locator('.settings-shell')).toBeVisible();
  await settings.screenshot({ path: path.join(output, 'desktop-compact.png') });

  expect(failures).toEqual([]);
  console.log(JSON.stringify({
    ok: true,
    scenarios: [
      'fresh startup without API key',
      'titlebar opens a separate settings window',
      'profile persistence through the original storage key',
      'theme persistence and immediate preview',
      'classroom preference persistence',
      'AI connection section',
      'handoff to the original advanced settings',
      'runtime controls',
      'compact window layout',
    ],
    output,
  }, null, 2));
} finally {
  await app.close();
}
