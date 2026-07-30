/**
 * sheet.js — worksheets that leave the Mac, get written on, and come back.
 *
 * The loop this supports: StudyOS writes a PDF into a synced folder, it shows up
 * in Files on the iPad, you answer with the Pencil, and the grader reads your
 * handwriting out of the same file. Nothing is ever uploaded by hand.
 *
 * Two invariants hold the design together:
 *
 *  1. **One question per page.** Grading question 3 is "look at page 3" — no
 *     answer-region coordinates, no crop maths, no layout parsing. There is
 *     deliberately no cover page, because that would break page == question.
 *
 *  2. **The manifest is the source of truth for intent.** The PDF says what was
 *     asked; the manifest (kept in the vault, never in iCloud) also records the
 *     topic and what a correct answer contains, so grading never has to
 *     re-derive the question from an image of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { classPaths, projectRoot, slugify, today } from './vault.js';

/** Characters per line in the generated worksheet. */
const WRAP = 76;

/** Blank lines left under each question for working. */
const WORK_LINES = 34;

// ---------------------------------------------------------------------------
// Where worksheets live
// ---------------------------------------------------------------------------

/**
 * The synced folder the iPad can see.
 *
 * Defaults to iCloud Drive, since it needs no extra app and is already active.
 * STUDYOS_SHEET_DIR overrides it — that's the escape hatch for Dropbox or
 * Google Drive, which is how a GoodNotes workflow would feed the same pipeline.
 */
export function sheetDir() {
  if (process.env.STUDYOS_SHEET_DIR) return path.resolve(process.env.STUDYOS_SHEET_DIR);
  return path.join(
    os.homedir(),
    'Library',
    'Mobile Documents',
    'com~apple~CloudDocs',
    'StudyOS',
    'worksheets',
  );
}

export function ensureSheetDir() {
  const dir = sheetDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Manifests live in the vault, so they are gitignored and never sync. */
export function manifestDir(classId, root = projectRoot()) {
  return path.join(classPaths(classId, root).dir, 'worksheets');
}

export function manifestPath(classId, slug, root = projectRoot()) {
  return path.join(manifestDir(classId, root), `${slug}.json`);
}

export function sheetSlug(classId, topics, date = today()) {
  const label = topics.length === 1 ? slugify(topics[0]) : `${topics.length}-topics`;
  return `${date}-${slugify(classId)}-${label}`;
}

// ---------------------------------------------------------------------------
// Generating the PDF
// ---------------------------------------------------------------------------

function wrap(text, width = WRAP) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line === '') line = word;
      else if (`${line} ${word}`.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Lay the worksheet out as plain text with form-feed page breaks.
 *
 * `cupsfilter` honours `\f`, which is what gives us exactly one question per
 * page with no PDF library and no new dependency.
 */
export function renderSheetText(manifest) {
  const pages = manifest.questions.map((q, i) => {
    const lines = [
      `Q${q.page} of ${manifest.questions.length}   ${q.topic}`,
      ''.padEnd(WRAP, '_'),
      '',
      ...wrap(q.question),
      '',
      ...Array(WORK_LINES).fill(''),
      // Footer identifies the sheet if a page is photographed on its own.
      `${manifest.class}  ${manifest.slug}  page ${q.page}`,
    ];
    return lines.join('\n');
  });
  // No trailing form feed: a final \f makes cupsfilter emit a blank extra page,
  // which would shift nothing but does put a stray page in front of the user.
  return pages.join('\n\f');
}

/**
 * Write the worksheet PDF into the synced folder.
 *
 * @returns {{ok: true, pdf: string, pages: number} | {ok: false, error: string}}
 */
export function writeSheetPdf(manifest, { dir } = {}) {
  const target = dir ?? ensureSheetDir();
  fs.mkdirSync(target, { recursive: true });

  const txt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-sheet-')), 'sheet.txt');
  fs.writeFileSync(txt, renderSheetText(manifest), 'utf8');

  const pdf = path.join(target, `${manifest.slug}.pdf`);
  const r = spawnSync('cupsfilter', [txt], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

  if (r.error) {
    return {
      ok: false,
      error: r.error.code === 'ENOENT' ? 'cupsfilter not found (macOS only)' : r.error.message,
    };
  }
  // cupsfilter chatters to stderr even on success, so trust the output bytes.
  if (!r.stdout || r.stdout.length === 0) {
    return { ok: false, error: (r.stderr?.toString() ?? '').trim() || 'cupsfilter produced no output' };
  }

  fs.writeFileSync(pdf, r.stdout);
  return { ok: true, pdf, pages: manifest.questions.length };
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

/**
 * @param {object} spec
 * @param {string} spec.class
 * @param {Array<{topic: string, question: string, expected?: string, difficulty?: string}>} spec.questions
 */
export function buildManifest(spec, { date = today() } = {}) {
  const topics = [...new Set(spec.questions.map((q) => slugify(q.topic)))];
  const slug = spec.slug ?? sheetSlug(spec.class, topics, date);
  return {
    slug,
    class: spec.class,
    date,
    sheet: `${slug}.pdf`,
    topics,
    // page is 1-based and equals the question number, by construction.
    questions: spec.questions.map((q, i) => ({
      page: i + 1,
      topic: slugify(q.topic),
      question: q.question,
      expected: q.expected ?? '',
      difficulty: q.difficulty ?? 'application',
    })),
  };
}

export function writeManifest(manifest, root = projectRoot()) {
  const file = manifestPath(manifest.class, manifest.slug, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  return file;
}

export function readManifest(classId, slug, root = projectRoot()) {
  const file = manifestPath(classId, slug, root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Manifests for a class, newest first. */
export function listManifests(classId, root = projectRoot()) {
  const dir = manifestDir(classId, root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.slug).localeCompare(String(a.slug)));
}

// ---------------------------------------------------------------------------
// Waiting for the iPad's edit to land
// ---------------------------------------------------------------------------

/**
 * Fingerprint of everything in the synced folder that could be the answer file.
 *
 * The *directory* is fingerprinted rather than one path because iPad Markup may
 * save in place or write a copy alongside, and this way the design doesn't
 * depend on which. Size and mtime are enough to notice an edit.
 *
 * `.icloud` placeholders are dataless stubs — the file exists in the index but
 * its bytes have not arrived. Treating them as absent is what stops us reading
 * an empty shell and grading it as blank.
 */
export function fingerprint(dir = sheetDir(), match = /\.pdf$/i) {
  if (!fs.existsSync(dir)) return { entries: [], key: '', pending: 0 };
  const names = fs.readdirSync(dir);
  const pending = names.filter((n) => n.endsWith('.icloud')).length;

  const entries = names
    .filter((n) => !n.startsWith('.') && match.test(n))
    .map((n) => {
      const s = fs.statSync(path.join(dir, n));
      return { name: n, size: s.size, mtimeMs: Math.round(s.mtimeMs) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    entries,
    pending,
    key: entries.map((e) => `${e.name}:${e.size}:${e.mtimeMs}`).join('|'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until the synced folder changes and then stops changing.
 *
 * Two phases, both necessary. Waiting for a *change* is how we know the iPad's
 * edit arrived at all. Then waiting for the fingerprint to hold still is what
 * prevents grading a file that is still being written — iCloud materialises
 * large files progressively, and a half-written PDF reads as a blank or
 * corrupt page, which the grader would otherwise report as "you left it blank".
 *
 * @returns {Promise<{ok: boolean, reason?: string, changed?: boolean}>}
 */
export async function waitForEdit(
  baseline,
  { dir = sheetDir(), timeoutMs = 180_000, settleMs = 2500, pollMs = 750, signal } = {},
) {
  const start = Date.now();
  let sawChange = false;
  let stableSince = null;
  let last = baseline?.key ?? fingerprint(dir).key;

  for (;;) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    if (Date.now() - start > timeoutMs) {
      return { ok: false, reason: sawChange ? 'never settled' : 'timed out waiting for a change' };
    }

    const now = fingerprint(dir);

    if (!sawChange) {
      if (now.key !== last) {
        sawChange = true;
        stableSince = Date.now();
        last = now.key;
      }
    } else if (now.key !== last) {
      // Still arriving — restart the settle clock.
      stableSince = Date.now();
      last = now.key;
    } else if (now.pending === 0 && Date.now() - stableSince >= settleMs) {
      return { ok: true, changed: true };
    }

    await sleep(pollMs);
  }
}

/** Newest PDF in the synced folder, ignoring placeholders. */
export function newestSheet(dir = sheetDir()) {
  const fp = fingerprint(dir);
  if (fp.entries.length === 0) return null;
  const newest = fp.entries.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  return path.join(dir, newest.name);
}

/**
 * The file to grade for a given manifest.
 *
 * Prefers an exact slug match. Falls back to any file whose name starts with the
 * slug, which covers apps that append a suffix when saving a copy
 * ("sheet 2.pdf", "sheet-annotated.pdf").
 */
export function resolveSheetFile(manifest, dir = sheetDir()) {
  const exact = path.join(dir, manifest.sheet);
  if (fs.existsSync(exact)) return exact;

  const fp = fingerprint(dir);
  const prefixed = fp.entries.filter((e) => e.name.startsWith(manifest.slug));
  if (prefixed.length === 0) return null;
  return path.join(dir, prefixed.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).name);
}
