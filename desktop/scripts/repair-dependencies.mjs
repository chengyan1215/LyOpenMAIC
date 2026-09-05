import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
        fs.cpSync(dependency, target, {
          recursive: true, dereference: true,
          filter: (entry) => path.relative(dependency, entry).split(path.sep)[0] !== 'node_modules',
        });
        copied++;
      }
      hydrate(dependency, target);
    }
  }
  function seedModules(relative) {
    const original = path.join(repo, '.next', 'standalone', relative);
    function walk(directory) {
      if (!fs.existsSync(directory)) return;
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.name === '.pnpm') continue;
        const source = path.join(directory, item.name);
        if (item.name.startsWith('@') && !fs.existsSync(path.join(source, 'package.json'))) {
          walk(source);
        } else if (fs.existsSync(path.join(source, 'package.json'))) {
          hydrate(fs.realpathSync(source), path.join(runtime, relative, path.relative(original, source)));
        }
      }
    }
    walk(original);
  }
  seedModules('node_modules');
  seedModules('.next/node_modules');
  console.log(`Resolved runtime dependency closure: ${visited.size} packages, ${copied} added`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repairDependencies(path.resolve(process.argv[2]));
}
