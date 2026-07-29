import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureVault, paths } from '../lib/vault.js';
import { append, query, stream, groupBy, topicStats } from '../lib/events.js';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-events-'));
  ensureVault(root);
  return root;
}

test('append stamps ts and returns the stored event', () => {
  const root = scratch();
  const e = append({ type: 'ingest', class: '15-122', source: 'a.pdf' }, root);
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.type, 'ingest');

  const lines = fs.readFileSync(paths(root).events, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), e);
});

test('append respects a caller-supplied ts', () => {
  const root = scratch();
  const e = append({ type: 'quiz', ts: '2026-09-14T21:03:00.000Z', class: 'x' }, root);
  assert.equal(e.ts, '2026-09-14T21:03:00.000Z');
});

test('append rejects malformed events', () => {
  const root = scratch();
  assert.throws(() => append({ class: 'x' }, root), /type is required/);
  assert.throws(() => append({ type: 'bogus' }, root), /unknown type/);
  assert.throws(() => append(null, root), /must be an object/);
});

test('append never writes a partial line under repeated writes', () => {
  const root = scratch();
  for (let i = 0; i < 200; i++) append({ type: 'session', class: '15-122', minutes: i }, root);
  const lines = fs.readFileSync(paths(root).events, 'utf8').trim().split('\n');
  assert.equal(lines.length, 200);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test('path fields are normalized to the class-relative form', () => {
  const root = scratch();
  const a = append(
    { type: 'ingest', class: '15-122', note: 'vault/classes/15-122/notes/x.md', source: './lecture-04.pdf' },
    root,
  );
  assert.equal(a.note, 'notes/x.md');
  assert.equal(a.source, 'lecture-04.pdf');

  const b = append({ type: 'ingest', class: '15-122', note: 'classes/15-122/notes/y.md' }, root);
  assert.equal(b.note, 'notes/y.md');

  // Already correct, and other classes' prefixes, are left alone.
  const c = append({ type: 'ingest', class: '15-122', note: 'notes/z.md' }, root);
  assert.equal(c.note, 'notes/z.md');
  const d = append({ type: 'ingest', class: '15-122', note: 'vault/classes/21-241/notes/w.md' }, root);
  assert.equal(d.note, 'vault/classes/21-241/notes/w.md');
});

test('query filters by type, class, topic, and time window', async () => {
  const root = scratch();
  append({ type: 'ingest', ts: '2026-09-01T00:00:00.000Z', class: '15-122' }, root);
  append({ type: 'quiz', ts: '2026-09-10T00:00:00.000Z', class: '15-122', topic: 'inv' }, root);
  append({ type: 'quiz', ts: '2026-09-20T00:00:00.000Z', class: '15-122', topic: 'sort' }, root);
  append({ type: 'quiz', ts: '2026-09-20T00:00:00.000Z', class: '21-241', topic: 'eig' }, root);

  assert.equal((await query({}, root)).length, 4);
  assert.equal((await query({ type: 'quiz' }, root)).length, 3);
  assert.equal((await query({ type: ['quiz', 'ingest'], class: '15-122' }, root)).length, 3);
  assert.equal((await query({ topic: 'inv' }, root)).length, 1);
  assert.equal((await query({ since: '2026-09-15T00:00:00.000Z' }, root)).length, 2);
  assert.equal((await query({ until: '2026-09-15T00:00:00.000Z' }, root)).length, 2);
});

test('query limit keeps the most recent events', async () => {
  const root = scratch();
  for (let i = 1; i <= 5; i++) {
    append({ type: 'session', ts: `2026-09-0${i}T00:00:00.000Z`, minutes: i }, root);
  }
  const got = await query({ limit: 2 }, root);
  assert.deepEqual(got.map((e) => e.minutes), [4, 5]);
});

test('a corrupt line does not make the whole log unreadable', async () => {
  const root = scratch();
  append({ type: 'quiz', class: '15-122' }, root);
  fs.appendFileSync(paths(root).events, '{"type":"quiz", truncated\n');
  append({ type: 'quiz', class: '15-122' }, root);

  const got = await query({}, root);
  assert.equal(got.length, 2);
});

test('stream on a fresh vault yields nothing', async () => {
  const root = scratch();
  const out = [];
  for await (const e of stream(root)) out.push(e);
  assert.deepEqual(out, []);
});

test('groupBy handles a key name and a function', () => {
  const events = [
    { type: 'quiz', class: 'a' },
    { type: 'quiz', class: 'b' },
    { type: 'ingest', class: 'a' },
    { type: 'ingest' },
  ];
  assert.equal(groupBy(events, 'class').get('a').length, 2);
  assert.equal(groupBy(events, 'class').size, 2); // undefined key skipped
  assert.equal(groupBy(events, (e) => e.type).get('quiz').length, 2);
});

test('topicStats rolls up accuracy and ranks repeated misses first', async () => {
  const root = scratch();
  append({ type: 'quiz', class: '15-122', topic: 'inv', asked: 8, correct: 5, missed: ['exit condition', 'metric'] }, root);
  append({ type: 'quiz', class: '15-122', topic: 'inv', asked: 4, correct: 4, missed: [] }, root);
  append({ type: 'exam', class: '15-122', topic: 'inv', asked: 2, correct: 0, missed: ['exit condition'] }, root);
  append({ type: 'quiz', class: '21-241', topic: 'eig', asked: 3, correct: 1 }, root);

  const stats = await topicStats('15-122', root);
  assert.deepEqual([...stats.keys()], ['inv']); // other class excluded

  const inv = stats.get('inv');
  assert.equal(inv.asked, 14);
  assert.equal(inv.correct, 9);
  assert.equal(inv.attempts, 3);
  assert.ok(Math.abs(inv.accuracy - 9 / 14) < 1e-9);
  assert.deepEqual(inv.topMissed[0], { concept: 'exit condition', count: 2 });
});

test('topicStats leaves accuracy null when nothing was asked', async () => {
  const root = scratch();
  append({ type: 'session', class: '15-122', topic: 'inv', minutes: 30 }, root);
  const stats = await topicStats('15-122', root);
  assert.equal(stats.size, 0); // sessions are not quiz/exam events
});
