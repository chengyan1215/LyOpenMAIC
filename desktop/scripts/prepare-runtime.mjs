import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairDependencies } from './repair-dependencies.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, '..');
const repositoryDirectory = path.resolve(desktopDirectory, '..');
const sourceDirectory = path.join(repositoryDirectory, '.next', 'standalone');
const targetDirectory = path.join(desktopDirectory, 'runtime', 'standalone');

function assertInsideDesktop(target) {
  const relative = path.relative(desktopDirectory, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify a path outside desktop/: ${target}`);
  }
}

function findServerEntry(directory) {
  const pending = [directory];
  const matches = [];
  while (pending.length) {
    const current = pending.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.name === 'server.js') matches.push(fullPath);
    }
  }
  const preferred = matches.find((entry) => fs.existsSync(path.join(path.dirname(entry), '.next')));
  return preferred || matches[0];
}

if (!fs.existsSync(sourceDirectory)) {
  throw new Error('Missing .next/standalone. Run `pnpm build` first.');
}

assertInsideDesktop(targetDirectory);
fs.rmSync(targetDirectory, { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetDirectory), { recursive: true });
fs.cpSync(sourceDirectory, targetDirectory, { recursive: true, dereference: true });

// Next's standalone output mirrors the repository root, which drags in
// desktop/dist (previous NSIS installers, hundreds of MB each). The packaged
// app never executes the server from this copy of desktop/, so prune it
// before electron-builder packs the runtime into the installer.
fs.rmSync(path.join(targetDirectory, 'desktop', 'dist'), { recursive: true, force: true });

// Turbopack's broad output tracing can also copy Playwright screenshots and
// isolated Electron user profiles. They are test artifacts, never runtime
// inputs, and can add hundreds of megabytes to the installer.
fs.rmSync(path.join(targetDirectory, 'e2e'), { recursive: true, force: true });

// With pnpm, Next's direct helpers can be present in the virtual store but
// have no hoisted aliases in standalone/node_modules. Electron then cannot
// resolve them at customer runtime. Materialize Next's complete direct set.
const runtimeNodeModules = path.join(targetDirectory, 'node_modules');
const projectVirtualStore = path.join(repositoryDirectory, 'node_modules', '.pnpm');
const nextStoreDirectory = fs
  .readdirSync(projectVirtualStore, { withFileTypes: true })
  .find((entry) => entry.isDirectory() && entry.name.startsWith('next@'));
if (nextStoreDirectory) {
  const nextDependencies = path.join(
    projectVirtualStore,
    nextStoreDirectory.name,
    'node_modules',
  );
  for (const dependency of fs.readdirSync(nextDependencies, { withFileTypes: true })) {
    if (dependency.name === 'next') continue;
    const source = path.join(nextDependencies, dependency.name);
    const target = path.join(runtimeNodeModules, dependency.name);
    if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true, dereference: true });
  }
}

const serverEntry = findServerEntry(targetDirectory);
if (!serverEntry) throw new Error('Next.js standalone output does not contain server.js.');
const serverDirectory = path.dirname(serverEntry);

const staticSource = path.join(repositoryDirectory, '.next', 'static');
const publicSource = path.join(repositoryDirectory, 'public');
if (fs.existsSync(staticSource)) {
  fs.cpSync(staticSource, path.join(serverDirectory, '.next', 'static'), {
    recursive: true,
    dereference: true,
  });
}
if (fs.existsSync(publicSource)) {
  fs.cpSync(publicSource, path.join(serverDirectory, 'public'), {
    recursive: true,
    dereference: true,
  });
}

fs.writeFileSync(
  path.join(targetDirectory, 'desktop-runtime.json'),
  `${JSON.stringify(
    { serverRelativePath: path.relative(targetDirectory, serverEntry).split(path.sep).join('/') },
    null,
    2,
  )}\n`,
  'utf8',
);

repairDependencies(targetDirectory);
console.log(`Prepared desktop runtime: ${targetDirectory}`);
console.log(`Server entry: ${path.relative(targetDirectory, serverEntry)}`);
