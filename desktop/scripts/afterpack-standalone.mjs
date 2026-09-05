/**
 * electron-builder afterPack hook.
 *
 * Mirrors the prepared Next.js standalone runtime (desktop/runtime/standalone)
 * into the staged app (resources/standalone).
 *
 * Strategy: the staging dir lives on the same NTFS volume as the source, so we
 * create HARD LINKS instead of copying data — a pure metadata operation
 * (~800 files/s observed vs ~50 files/s for robocopy /MT:48 on this machine;
 * the runtime tree is ~100k small files after AWS exclusion). Files that
 * cannot be hard-linked (cross-volume, symlinked sources) fall back to a real
 * copy. Nothing modifies staged standalone files afterwards (rcedit only
 * touches the exe; NSIS only reads), so sharing content with the source is
 * safe.
 *
 * Excludes the AWS SDK trees (~160k files, 61% of the runtime). All usages
 * are lazy dynamic import() (S3/Bedrock backends), never loaded unless
 * configured via env. Safe to omit from the desktop package.
 *
 * The standalone entries were removed from build.extraResources in
 * package.json; keep them out or the slow copy runs twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED_DIR_NAMES = new Set(['@aws-sdk', '@aws-crypto', '@smithy']);

function mirror(src, dest, stats) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      mirror(path.join(src, entry.name), path.join(dest, entry.name), stats);
    } else if (entry.isFile()) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      try {
        fs.linkSync(from, to);
        stats.linked++;
      } catch {
        fs.copyFileSync(from, to);
        stats.copied++;
      }
    }
    // Symlinks and other types are dereferenced/ignored: standalone node_modules
    // produced by Next is expected to be real files; anything unusual is not
    // worth preserving (a dangling symlink would break the packaged app).
  }
}

export default async function afterPack(context) {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = path.join(projectDir, 'runtime', 'standalone');
  const destination = path.join(context.appOutDir, 'resources', 'standalone');

  const t0 = Date.now();
  const stats = { linked: 0, copied: 0 };
  mirror(source, destination, stats);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    `[afterpack] standalone runtime mirrored: ${stats.linked} hardlinked, ` +
      `${stats.copied} copied (fallback), ${secs}s — ${source} -> ${destination}`,
  );
}
