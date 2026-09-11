import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '../..');
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(command, ['build'], {
  cwd: repositoryDirectory,
  env: {
    ...process.env,
    NEXT_PUBLIC_MAIC_EDITOR_ENABLED: '1',
  },
  stdio: 'inherit',
  // Windows cannot spawn a .cmd shim directly on current Node releases.
  // The command and arguments are fixed here; no user input reaches the shell.
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
