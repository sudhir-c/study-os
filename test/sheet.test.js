import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureVault, createClass } from '../lib/vault.js';
import {
  sheetDir,
  buildManifest,
  writeManifest,
  readManifest,
  listManifests,
  renderSheetText,
  writeSheetPdf,
  fingerprint,
  waitForEdit,
  resolveSheetFile,
  newestSheet,
  sheetSlug,
} from '../lib/sheet.js';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-sheet-'));
  ensureVault(root);
  createClass('15-122', {}, root);
  return root;
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-synced-'));

const QS = [
  { topic: 'Loop Invariants', question: 'State the four proof obligations.', expected: 'INIT PRES EXIT TERM' },
  { topic: 'loop-invariants', question: 'Prove preservation when A[mid] < x.', expected: 'lo=mid+1 safe' },
  { topic: 'Big-O Analysis', question: 'Show 2^n is not O(n^100).', expected: 'no c, n0 exist' },
];

// --- paths -----------------------------------------------------------------

test('STUDYOS_SHEET_DIR overrides the iCloud default', () => {
  const saved = process.env.STUDYOS_SHEET_DIR;
  try {
    process.env.STUDYOS_SHEET_DIR = '/tmp/some/dropbox/folder';
    assert.equal(sheetDir(), '/tmp/some/dropbox/folder');
    delete process.env.STUDYOS_SHEET_DIR;
    assert.match(sheetDir(), /Mobile Documents\/com~apple~CloudDocs\/StudyOS\/worksheets$/);
  } finally {
    if (saved === undefined) delete process.env.STUDYOS_SHEET_DIR;
    else process.env.STUDYOS_SHEET_DIR = saved;
  }
});

test('sheetSlug names single-topic and multi-topic sheets differently', () => {
  assert.equal(sheetSlug('15-122', ['loop-invariants'], '2026-07-29'), '2026-07-29-15-122-loop-invariants');
  assert.equal(sheetSlug('15-122', ['a', 'b', 'c'], '2026-07-29'), '2026-07-29-15-122-3-topics');
});

// --- manifest --------------------------------------------------------------

test('page numbers are 1-based and match question order exactly', () => {
  const m = buildManifest({ class: '15-122', questions: QS }, { date: '2026-07-29' });
  assert.deepEqual(m.questions.map((q) => q.page), [1, 2, 3]);
  assert.equal(m.questions[1].question, QS[1].question, 'page 2 must be the second question');
});

test('topics are slugified so grading can look up the prediction by slug', () => {
  const m = buildManifest({ class: '15-122', questions: QS });
  assert.deepEqual(m.questions.map((q) => q.topic), [
    'loop-invariants',
    'loop-invariants',
    'big-o-analysis',
  ]);
  assert.deepEqual(m.topics, ['loop-invariants', 'big-o-analysis'], 'deduplicated');
});

test('manifest round-trips through the vault', () => {
  const root = scratch();
  const m = buildManifest({ class: '15-122', questions: QS }, { date: '2026-07-29' });
  const file = writeManifest(m, root);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(readManifest('15-122', m.slug, root), m);
  assert.equal(readManifest('15-122', 'no-such-sheet', root), null);
});

test('manifests are listed newest first', () => {
  const root = scratch();
  for (const d of ['2026-07-01', '2026-07-29', '2026-07-15']) {
    writeManifest(buildManifest({ class: '15-122', questions: QS }, { date: d }), root);
  }
  const dates = listManifests('15-122', root).map((m) => m.date);
  assert.deepEqual(dates, ['2026-07-29', '2026-07-15', '2026-07-01']);
});

test('a corrupt manifest is skipped rather than breaking the listing', () => {
  const root = scratch();
  writeManifest(buildManifest({ class: '15-122', questions: QS }, { date: '2026-07-29' }), root);
  const dir = path.join(root, 'vault/classes/15-122/worksheets');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  assert.equal(listManifests('15-122', root).length, 1);
});

// --- layout ----------------------------------------------------------------

test('one question per page, with no trailing blank page', () => {
  const m = buildManifest({ class: '15-122', questions: QS });
  const txt = renderSheetText(m);
  const formFeeds = (txt.match(/\f/g) ?? []).length;
  assert.equal(formFeeds, 2, '3 questions need 2 breaks, not 3 — a trailing \\f adds a blank page');
});

test('long questions are wrapped rather than running off the page', () => {
  const long = 'word '.repeat(120).trim();
  const m = buildManifest({ class: '15-122', questions: [{ topic: 't', question: long }] });
  const lines = renderSheetText(m).split('\n');
  for (const l of lines) assert.ok(l.length <= 80, `line too wide: ${l.length}`);
});

test('each page carries the class and slug for a photographed page', () => {
  const m = buildManifest({ class: '15-122', questions: QS }, { date: '2026-07-29' });
  const pages = renderSheetText(m).split('\f');
  for (const p of pages) assert.ok(p.includes(m.slug) && p.includes('15-122'));
});

test('writeSheetPdf produces one PDF page per question', () => {
  const m = buildManifest({ class: '15-122', questions: QS }, { date: '2026-07-29' });
  const dir = tmpdir();
  const res = writeSheetPdf(m, { dir });
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.existsSync(res.pdf));
  assert.equal(res.pages, 3);
  assert.ok(fs.readFileSync(res.pdf).subarray(0, 5).toString().startsWith('%PDF'));
});

// --- sync fingerprinting ---------------------------------------------------

test('fingerprint ignores dotfiles and counts iCloud placeholders', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  fs.writeFileSync(path.join(dir, '.b.pdf.icloud'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');

  const fp = fingerprint(dir);
  assert.deepEqual(fp.entries.map((e) => e.name), ['a.pdf'], 'only real PDFs');
  assert.equal(fp.pending, 1, 'placeholder means bytes have not arrived');
});

test('fingerprint changes when a file is edited', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'a.pdf');
  fs.writeFileSync(f, 'original');
  const before = fingerprint(dir).key;
  fs.writeFileSync(f, 'annotated and therefore longer');
  assert.notEqual(fingerprint(dir).key, before);
});

test('fingerprint on a missing directory is empty, not a throw', () => {
  const fp = fingerprint('/nonexistent/xyz');
  assert.deepEqual(fp.entries, []);
  assert.equal(fp.key, '');
});

test('waitForEdit times out when nothing changes', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  const res = await waitForEdit(fingerprint(dir), { dir, timeoutMs: 600, pollMs: 100, settleMs: 100 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /timed out/);
});

test('waitForEdit returns once an edit lands and settles', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'a.pdf');
  fs.writeFileSync(f, 'x');
  const base = fingerprint(dir);
  setTimeout(() => fs.writeFileSync(f, 'annotated'), 150);

  const res = await waitForEdit(base, { dir, timeoutMs: 5000, pollMs: 80, settleMs: 300 });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
});

test('waitForEdit can be cancelled', async () => {
  const dir = tmpdir();
  const ctrl = new AbortController();
  ctrl.abort();
  const res = await waitForEdit(fingerprint(dir), { dir, signal: ctrl.signal, timeoutMs: 5000 });
  assert.equal(res.reason, 'cancelled');
});

// --- locating the annotated file -------------------------------------------

test('resolveSheetFile prefers an exact match', () => {
  const dir = tmpdir();
  const m = buildManifest({ class: '15-122', questions: QS }, { date: '2026-07-29' });
  fs.writeFileSync(path.join(dir, m.sheet), 'x');
  assert.equal(resolveSheetFile(m, dir), path.join(dir, m.sheet));
});

test('resolveSheetFile falls back to a renamed copy', () => {
  // Some apps save annotations as "<name> 2.pdf" instead of editing in place.
  const dir = tmpdir();
  const m = buildManifest({ class: '15-122', questions: QS }, { date: '2026-07-29' });
  fs.writeFileSync(path.join(dir, `${m.slug} 2.pdf`), 'annotated');
  const got = resolveSheetFile(m, dir);
  assert.ok(got?.endsWith(' 2.pdf'), `expected the copy, got ${got}`);
});

test('resolveSheetFile returns null when nothing has synced', () => {
  const m = buildManifest({ class: '15-122', questions: QS });
  assert.equal(resolveSheetFile(m, tmpdir()), null);
});

test('newestSheet picks the most recently modified PDF', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'old.pdf'), 'x');
  fs.writeFileSync(path.join(dir, 'new.pdf'), 'x');
  const future = Date.now() / 1000 + 60;
  fs.utimesSync(path.join(dir, 'new.pdf'), future, future);
  assert.ok(newestSheet(dir).endsWith('new.pdf'));
  assert.equal(newestSheet(tmpdir()), null);
});
