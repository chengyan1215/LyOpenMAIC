import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Slow spinning/Boot Camp disks make fs.cpSync pathologically slow for the
// tens of thousands of small files in a dependency closure. robocopy /MT
// parallelizes per-file latency on Windows; cpSync stays as the POSIX path.
function copyTree(source, destination, excludeNodeModules = true) {
  if (process.platform === 'win32') {
    const args = [source, destination, '/E', '/MT:16', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'];
    if (excludeNodeModules) args.push('/XD', path.join(source, 'node_modules'));
    const result = spawnSync('robocopy', args, { stdio: 'ignore' });
    // robocopy: exit codes 0-7 are success (1 = files copied, 3 = extras + copied, ...)
    if (result.status === null || result.status > 7) {
      throw new Error(`robocopy failed (${result.status}): ${source} -> ${destination}`);
    }
    return;
  }
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    ...(excludeNodeModules
      ? { filter: (entry) => path.relative(source, entry).split(path.sep)[0] !== 'node_modules' }
      : {}),
  });
}

export function repairDependencies(runtime) {
  const rootModules = path.join(runtime, 'node_modules');
  const visited = new Set();
  let copied = 0;
  function metadata(directory) {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  }
  function resolvePackage(name, from) {
    for (let current = from; ; current = path.dirname(current)) {
      const candidate = path.join(current, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
      if (path.dirname(current) === current) return null;
    }
  }
  function hydrate(source, destination) {
    const key = `${source}|${destination}`;
    if (visited.has(key)) return;
    visited.add(key);
    const info = metadata(source);
    const optional = info.optionalDependencies || {};
    const deps = { ...info.dependencies, ...optional };
    for (const name of Object.keys(deps)) {
      const dependency = resolvePackage(name, source);
      if (!dependency) {
        if (name in optional) continue;
        throw new Error(`Missing installed dependency ${info.name} -> ${name}`);
      }
      const version = metadata(dependency).version;
      let target = path.join(rootModules, name);
      if (fs.existsSync(path.join(target, 'package.json')) && metadata(target).version !== version) {
        target = path.join(destination, 'node_modules', name);
      }
      if (!fs.existsSync(path.join(target, 'package.json'))) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        copyTree(dependency, target, true);
        copied++;
      }
      hydrate(dependency, target);
    }
  }
  function resolveRealPackage(name) {
    const direct = path.join(repo, 'node_modules', name);
    if (fs.existsSync(path.join(direct, 'package.json'))) return fs.realpathSync(direct);
    const store = path.join(repo, 'node_modules', '.pnpm');
    if (!fs.existsSync(store)) return null;
    const storeKey = `${name.replace('/', '+')}@`;
    const entry = fs.readdirSync(store).find((item) => item.startsWith(storeKey));
    if (!entry) return null;
    const candidate = path.join(store, entry, 'node_modules', name);
    return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : null;
  }

  function seedModules(relative) {
    const original = path.join(repo, '.next', 'standalone', relative);
    function walk(directory, scope = '') {
      if (!fs.existsSync(directory)) return;
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.name === '.pnpm') continue;
        const source = path.join(directory, item.name);
        const name = `${scope}${item.name}`;
        const destination = path.join(runtime, relative, path.relative(original, source));
        if (item.name.startsWith('@') && !fs.existsSync(path.join(source, 'package.json'))) {
          walk(source, `${name}/`);
        } else if (fs.existsSync(path.join(source, 'package.json'))) {
          const real = fs.realpathSync(source);
          if (!fs.existsSync(path.join(destination, 'package.json'))) {
            // Present in the standalone source but missing/broken in the
            // runtime copy (partial quarantine, interrupted copy, ...).
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            copyTree(real, destination, true);
            copied++;
          }
          hydrate(real, destination);
        } else if (item.isDirectory()) {
          // next build occasionally leaves an empty directory for a package
          // that should be a pnpm junction (observed with next/react/etc. on
          // 2026-09-06), which ships a runtime that cannot even resolve
          // `next`. Materialize the real package from the repository install.
          // Next 16 externalizes some packages under "<name>-<16-hex-hash>"
          // directories inside .next/node_modules (e.g. pg-4c0d8067d674414d).
          // Those are real, required at runtime by literal path — strip the
          // hash and materialize the underlying package. Anything that still
          // does not resolve is interrupted-build temp residue; skip it.
          let real = resolveRealPackage(name);
          if (!real) {
            const hashed = name.match(/^(.+)-([0-9a-f]{16})$/);
            if (hashed) real = resolveRealPackage(hashed[1]);
          }
          if (!real) {
            console.warn(`[repair] skipping unresolvable standalone entry: ${name}`);
            continue;
          }
          fs.mkdirSync(destination, { recursive: true });
          copyTree(real, destination, true);
          copied++;
          hydrate(real, destination);
        }
      }
    }
    walk(original);
  }
  seedModules('node_modules');
  seedModules('.next/node_modules');
  const nextEntry = path.join(runtime, 'node_modules', 'next', 'package.json');
  if (!fs.existsSync(nextEntry)) {
    throw new Error('Runtime materialization failed: node_modules/next is missing after repair.');
  }
  console.log(`Resolved runtime dependency closure: ${visited.size} packages, ${copied} added`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repairDependencies(path.resolve(process.argv[2]));
}
