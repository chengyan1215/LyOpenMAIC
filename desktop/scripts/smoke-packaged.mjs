import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const directory = path.resolve(process.argv[2]);
const executable = path.join(directory, '智学课堂.exe');
const runtime = process.argv[3] ? path.resolve(process.argv[3]) : path.join(directory, 'resources', 'standalone');
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'desktop-runtime.json'), 'utf8'));
const server = path.join(runtime, manifest.serverRelativePath);
const socket = net.createServer();
await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const child = spawn(executable, [server], {
  cwd: path.dirname(server), windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: String(port),
    NEXT_PRIVATE_STANDALONE: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (data) => { output += data; });
child.stderr.on('data', (data) => { output += data; });
let failure;
child.on('error', (error) => { failure = error; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (response.status !== 200) throw new Error(`Health HTTP ${response.status}`);
      const body = await response.text();
      if (!body.includes('"status":"ok"')) throw new Error('Health payload is not OK');
      ready = true;
      console.log('PASS /api/health HTTP 200, status=ok');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error('Health check did not pass');
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(30000) });
  const html = await response.text();
  if (response.status !== 200 || !html.includes('智学课堂')) {
    throw new Error(`Homepage invalid: HTTP ${response.status}`);
  }
  console.log('PASS / HTTP 200, product title present');
} catch (error) {
  console.error(error.message);
  console.error(output.slice(0, 6000));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}
