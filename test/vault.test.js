import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseFrontmatter,
  stringifyFrontmatter,
  slugify,
  today,
  readDoc,
  writeDoc,
  patchDoc,
  createClass,
  listClasses,
  resolveClass,
  ensureVault,
} from '../lib/vault.js';

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-vault-'));
}

test('frontmatter round-trips exactly', () => {
  const data = {
    class: '15-122',
    topic: 'loop-invariants',
    mastery: 2,
    attempts: 7,
    next_review: '2026-09-17',
    confusions: ['mixes up loop invariant with postcondition'],
    sources: [],
    active: true,
  };
  const body = '# Summary\n\nSome content.';
  const parsed = parseFrontmatter(stringifyFrontmatter(data, body));
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body.trim(), body);
});

test('preserves types rather than stringifying everything', () => {
  const { data } = parseFrontmatter('---\nn: 3\nf: 1.5\nb: true\nnul: null\narr: [1,2]\n---\n');
  assert.equal(data.n, 3);
  assert.equal(data.f, 1.5);
  assert.equal(data.b, true);
  assert.equal(data.nul, null);
  assert.deepEqual(data.arr, [1, 2]);
});

test('bare identifiers and dates stay strings', () => {
  const { data } = parseFrontmatter('---\nclass: 15-122\nd: 2026-09-17\n---\n');
  assert.equal(data.class, '15-122');
  assert.equal(data.d, '2026-09-17');
});

test('strips trailing comments but not # inside values', () => {
  const { data } = parseFrontmatter('---\nmastery: 2 # 0-5\nurl: http://x.com/#frag\ns: "a # b"\n---\n');
  assert.equal(data.mastery, 2);
  assert.equal(data.url, 'http://x.com/#frag');
  assert.equal(data.s, 'a # b');
});

test('tolerates YAML block lists on read', () => {
  const { data } = parseFrontmatter('---\ntags:\n  - alpha\n  - beta\nx: 1\n---\nbody');
  assert.deepEqual(data.tags, ['alpha', 'beta']);
  assert.equal(data.x, 1);
});

test('quotes strings that would otherwise reparse as another type', () => {
  const out = stringifyFrontmatter({ a: '123', b: 'true', c: 'plain text' });
  assert.match(out, /a: "123"/);
  assert.match(out, /b: "true"/);
  assert.match(out, /c: plain text/);
  assert.deepEqual(parseFrontmatter(out).data, { a: '123', b: 'true', c: 'plain text' });
});

test('documents without frontmatter pass through untouched', () => {
  const { data, body } = parseFrontmatter('# Just markdown\n\ntext');
  assert.deepEqual(data, {});
  assert.equal(body, '# Just markdown\n\ntext');
});

test('unterminated frontmatter is treated as body, not silently eaten', () => {
  const raw = '---\nclass: 15-122\n\n# heading';
  const { data, body } = parseFrontmatter(raw);
  assert.deepEqual(data, {});
  assert.equal(body, raw);
});

test('slugify normalizes to lowercase hyphenated ascii', () => {
  assert.equal(slugify('Big-O & Amortized Analysis!'), 'big-o-amortized-analysis');
  assert.equal(slugify('  Loop Invariants  '), 'loop-invariants');
  assert.equal(slugify('naïve Bayes'), 'naive-bayes');
});

test('today() uses local calendar date', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(today(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
});

test('patchDoc merges frontmatter without touching the body', () => {
  const root = scratch();
  const f = path.join(root, 'topic.md');
  writeDoc(f, { class: '15-122', mastery: 1 }, '## Summary\n\noriginal body');
  patchDoc(f, { mastery: 3, next_review: '2026-09-20' });
  const doc = readDoc(f);
  assert.equal(doc.data.mastery, 3);
  assert.equal(doc.data.class, '15-122');
  assert.equal(doc.data.next_review, '2026-09-20');
  assert.match(doc.body, /original body/);
});

test('readDoc returns null for a missing file', () => {
  assert.equal(readDoc(path.join(scratch(), 'nope.md')), null);
});

test('createClass scaffolds dirs and is idempotent on class.md', () => {
  const root = scratch();
  ensureVault(root);
  createClass('15-122', { title: 'Imperative Computation' }, root);
  const dir = path.join(root, 'vault/classes/15-122');
  for (const sub of ['topics', 'notes', 'sources', 'exams']) {
    assert.ok(fs.existsSync(path.join(dir, sub)), `${sub}/ should exist`);
  }
  patchDoc(path.join(dir, 'class.md'), { instructor: 'Someone' });
  createClass('15-122', { title: 'Overwritten?' }, root); // must not clobber
  const doc = readDoc(path.join(dir, 'class.md'));
  assert.equal(doc.data.title, 'Imperative Computation');
  assert.equal(doc.data.instructor, 'Someone');
});

test('resolveClass matches id, case, alias, and unique prefix', () => {
  const root = scratch();
  ensureVault(root);
  createClass('15-122', { title: 'A', aliases: ['imperative'] }, root);
  createClass('21-241', { title: 'B' }, root);

  assert.equal(resolveClass('15-122', root), '15-122');
  assert.equal(resolveClass('IMPERATIVE', root), '15-122');
  assert.equal(resolveClass('15122', root), '15-122');
  assert.equal(resolveClass('21', root), '21-241');
  assert.equal(resolveClass('99-999', root), null);
  assert.deepEqual(listClasses(root), ['15-122', '21-241']);
});

test('resolveClass throws on an ambiguous prefix rather than picking one', () => {
  const root = scratch();
  ensureVault(root);
  createClass('15-122', {}, root);
  createClass('15-150', {}, root);
  assert.throws(() => resolveClass('15', root), /Ambiguous/);
});
