/**
 * folder.js — pull files from an external export directory into inbox/.
 *
 * This is the adapter for anything that can export a file: GoodNotes,
 * Notability, a scanner app's iCloud folder, a Shortcuts automation dumping
 * PDFs. Whatever you switch to next year, if it can write a file to a folder,
 * this covers it without touching anything downstream.
 *
 * Copies rather than moves, so the source app keeps its own library intact,
 * and tracks what it has already seen so repeated pulls are idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, projectRoot } from '../vault.js';

const SYNC_STATE = '.folder-sync.json';

export const SUPPORTED = ['.pdf', '.png', '.jpg', '.jpeg', '.heic', '.md', '.txt'];

function statePath(root) {
  return path.join(paths(root).log, SYNC_STATE);
}

function readState(root) {
  const f = statePath(root);
  if (!fs.existsSync(f)) return { seen: {} };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { seen: {} };
  }
}

/**
 * Identity of a file for dedupe purposes. Size+mtime rather than a content
 * hash: it's enough to catch "already pulled this", and hashing a folder of
 * large PDFs on every sync isn't worth the cost.
 */
function fingerprint(file) {
  const s = fs.statSync(file);
  return `${s.size}:${Math.round(s.mtimeMs)}`;
}

/**
 * Copy new files from `dir` into inbox/.
 *
 * @param {string}  dir              source directory
 * @param {object}  [opts]
 * @param {boolean} [opts.recursive] descend into subdirectories
 * @param {boolean} [opts.all]       re-copy even files already seen
 * @param {boolean} [opts.dryRun]    report without copying
 * @param {string}  [opts.prefix]    filename prefix, e.g. "goodnotes"
 */
export function sync(dir, { recursive = false, all = false, dryRun = false, prefix = '', root = projectRoot() } = {}) {
  const src = path.resolve(dir);
  if (!fs.existsSync(src)) return { ok: false, error: `No such directory: ${src}` };
  if (!fs.statSync(src).isDirectory()) return { ok: false, error: `Not a directory: ${src}` };

  const state = readState(root);
  const inbox = paths(root).inbox;
  fs.mkdirSync(inbox, { recursive: true });

  const copied = [];
  const skipped = [];
  const ignored = [];

  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);

      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      if (!SUPPORTED.includes(path.extname(entry.name).toLowerCase())) {
        ignored.push(entry.name);
        continue;
      }

      const key = path.relative(src, full);
      const fp = fingerprint(full);
      if (!all && state.seen[key] === fp) {
        skipped.push(entry.name);
        continue;
      }

      // Flatten subdirectories into the filename so inbox/ stays flat and
      // "week3/lecture.pdf" doesn't collide with "week4/lecture.pdf".
      const flat = key.split(path.sep).join('-');
      const dest = path.join(inbox, prefix ? `${prefix}-${flat}` : flat);

      if (!dryRun) {
        fs.copyFileSync(full, dest);
        state.seen[key] = fp;
      }
      copied.push(path.basename(dest));
    }
  };

  walk(src);

  if (!dryRun) fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2), 'utf8');

  return { ok: true, copied, skipped, ignored, source: src };
}
