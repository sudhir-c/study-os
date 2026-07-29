/**
 * apple-notes.js — pull typed Apple Notes into inbox/ as markdown.
 *
 * KNOWN LIMITATION, by design and not fixable here: Apple Notes handwriting
 * (Scribble drawings) is NOT reachable through AppleScript. `body` returns the
 * note's HTML, and inline drawings simply are not in it. Handwritten notes must
 * go the export route — Share → Export as PDF into inbox/ — which is the same
 * path GoodNotes/Notability would use. This adapter covers typed notes only,
 * and says so when it finds a note whose body is empty.
 *
 * Uses osascript against the running Notes.app rather than reading
 * NoteStore.sqlite: the local store is a compressed protobuf whose layout
 * changes between macOS releases, and on this machine it isn't even populated.
 *
 * Requires granting Automation permission for Notes on first run (macOS will
 * prompt once).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, slugify, projectRoot } from '../vault.js';

const SYNC_STATE = '.apple-notes-sync.json';

/**
 * AppleScript emitting one record per note. Fields are separated by control
 * characters that cannot appear in note text, so the output parses
 * unambiguously regardless of what the notes contain.
 */
const FIELD_SEP = '\u001f'; // ASCII unit separator
const RECORD_SEP = '\u001e'; // ASCII record separator

function script(folderName) {
  const selector = folderName
    ? `set theNotes to notes of folder ${JSON.stringify(folderName)}`
    : `set theNotes to notes`;

  // Separators are built with `character id` — AppleScript has no \u escapes,
  // and these two control characters cannot occur in note text, so the output
  // parses unambiguously no matter what the notes contain.
  return `
set fsep to (character id 31)
set rsep to (character id 30)
tell application "Notes"
  ${selector}
  set out to ""
  repeat with n in theNotes
    set noteId to id of n as string
    set noteName to name of n as string
    set noteBody to body of n as string
    set noteMod to ((modification date of n) as «class isot») as string
    set out to out & noteId & fsep & noteName & fsep & noteMod & fsep & noteBody & rsep
  end repeat
  return out
end tell
`;
}

/** Minimal HTML → markdown. Apple Notes emits a small, predictable subset. */
export function htmlToMarkdown(html) {
  let s = html;

  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/\s*(div|p|li|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<\s*li[^>]*>/gi, '- ');
  s = s.replace(/<\s*h1[^>]*>/gi, '\n# ');
  s = s.replace(/<\s*h2[^>]*>/gi, '\n## ');
  s = s.replace(/<\s*h3[^>]*>/gi, '\n### ');
  s = s.replace(/<\s*(b|strong)\s*>(.*?)<\s*\/\s*\1\s*>/gis, '**$2**');
  s = s.replace(/<\s*(i|em)\s*>(.*?)<\s*\/\s*\1\s*>/gis, '_$2_');
  s = s.replace(/<\s*code\s*>(.*?)<\s*\/\s*code\s*>/gis, '`$1`');
  s = s.replace(/<[^>]+>/g, ''); // drop anything left

  const entities = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
  };
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? m);

  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function syncStatePath(root) {
  return path.join(paths(root).log, SYNC_STATE);
}

function readSyncState(root) {
  const f = syncStatePath(root);
  if (!fs.existsSync(f)) return { notes: {} };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { notes: {} };
  }
}

function writeSyncState(root, state) {
  fs.writeFileSync(syncStatePath(root), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Export new or modified notes into inbox/ as markdown.
 *
 * Incremental: a note is re-exported only when its modification date advances
 * past what was recorded last run, so repeated syncs are cheap and don't
 * re-ingest the same lecture.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.folder]  restrict to one Notes folder (e.g. "School")
 * @param {boolean} [opts.all]     ignore sync state and export everything
 * @param {boolean} [opts.dryRun]  report without writing
 */
export function sync({ folder, all = false, dryRun = false, root = projectRoot() } = {}) {
  const res = spawnSync('osascript', ['-e', script(folder)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    if (res.error.code === 'ENOENT') {
      return { ok: false, error: 'osascript not found — this adapter is macOS only.' };
    }
    return { ok: false, error: res.error.message };
  }
  if (res.status !== 0) {
    const err = (res.stderr || '').trim();
    if (/-1743|not authorized|not allowed/i.test(err)) {
      return {
        ok: false,
        error:
          'macOS denied Automation access to Notes.\n' +
          '  Grant it in System Settings → Privacy & Security → Automation,\n' +
          '  then run this again.',
      };
    }
    if (/-1728|Can.t get folder/i.test(err) && folder) {
      return { ok: false, error: `No Notes folder named "${folder}".` };
    }
    return { ok: false, error: err || `osascript exited ${res.status}` };
  }

  const state = readSyncState(root);
  const inbox = paths(root).inbox;
  fs.mkdirSync(inbox, { recursive: true });

  const written = [];
  const skipped = [];
  const emptyBodies = [];

  const records = res.stdout.split('\u001e').filter((r) => r.trim());
  for (const rec of records) {
    const [id, name, modified, ...bodyParts] = rec.split('\u001f');
    if (!id) continue;
    const body = bodyParts.join('\u001f');

    const previous = state.notes[id];
    if (!all && previous && previous >= modified) {
      skipped.push(name);
      continue;
    }

    const markdown = htmlToMarkdown(body ?? '');
    // A note whose body is empty but which exists is the handwriting case:
    // the drawing is real content AppleScript cannot see.
    if (!markdown || markdown === name) {
      emptyBodies.push(name);
      continue;
    }

    const date = (modified || '').slice(0, 10) || 'undated';
    const file = path.join(inbox, `apple-notes-${date}-${slugify(name) || 'untitled'}.md`);

    if (!dryRun) {
      fs.writeFileSync(
        file,
        `<!-- source: Apple Notes · "${name}" · modified ${modified} -->\n\n# ${name}\n\n${markdown}\n`,
        'utf8',
      );
      state.notes[id] = modified;
    }
    written.push(path.basename(file));
  }

  if (!dryRun) writeSyncState(root, state);

  return { ok: true, written, skipped, emptyBodies, total: records.length };
}
