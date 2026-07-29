import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureVault, createClass, readDoc, writeDoc, topicPath } from '../lib/vault.js';
import { append } from '../lib/events.js';
import {
  computeMastery,
  nextReview,
  deriveTopics,
  rebuildClass,
  dueTopics,
  INTERVALS,
} from '../lib/mastery.js';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-mastery-'));
  ensureVault(root);
  createClass('15-122', {}, root);
  return root;
}

const q = (ts, asked, correct, missed = []) => ({
  type: 'quiz',
  ts,
  class: '15-122',
  topic: 'inv',
  asked,
  correct,
  missed,
});

test('no attempts yields null mastery rather than zero', () => {
  const m = computeMastery([]);
  assert.equal(m.mastery, null);
  assert.equal(m.accuracy, null);
  assert.equal(m.attempts, 0);
});

test('confidence cap prevents claiming mastery on too few questions', () => {
  const m = computeMastery([q('2026-09-01T00:00:00Z', 2, 2)]);
  assert.equal(m.accuracy, 1);
  assert.equal(m.cap, 2);
  assert.equal(m.mastery, 2, 'perfect on 2 questions is not mastery 5');
});

test('a single sitting cannot demonstrate durable mastery however many questions', () => {
  // 20 questions, all correct, but all in one day.
  const oneDay = computeMastery([
    q('2026-09-01T09:00:00Z', 10, 10),
    q('2026-09-01T09:30:00Z', 10, 10),
  ]);
  assert.equal(oneDay.sittings, 1);
  assert.equal(oneDay.mastery, 3, 'one sitting caps at 3 regardless of volume');
});

test('mastery 5 requires volume and repeated sittings', () => {
  const two = computeMastery([
    q('2026-09-01T00:00:00Z', 10, 10),
    q('2026-09-08T00:00:00Z', 10, 10),
  ]);
  assert.equal(two.sittings, 2);
  assert.equal(two.mastery, 4, 'two sittings caps at 4');

  const three = computeMastery([
    q('2026-09-01T00:00:00Z', 10, 10),
    q('2026-09-08T00:00:00Z', 10, 10),
    q('2026-09-15T00:00:00Z', 10, 10),
  ]);
  assert.equal(three.mastery, 5);
});

test('recent attempts dominate the estimate', () => {
  const improving = computeMastery([
    q('2026-09-01T00:00:00Z', 10, 2),
    q('2026-09-02T00:00:00Z', 10, 5),
    q('2026-09-03T00:00:00Z', 10, 10),
  ]);
  const declining = computeMastery([
    q('2026-09-01T00:00:00Z', 10, 10),
    q('2026-09-02T00:00:00Z', 10, 5),
    q('2026-09-03T00:00:00Z', 10, 2),
  ]);
  assert.equal(improving.accuracy, declining.accuracy, 'same raw accuracy');
  assert.ok(
    improving.mastery > declining.mastery,
    `improving (${improving.mastery}) should outrank declining (${declining.mastery})`,
  );
});

test('order of input events does not matter', () => {
  const a = computeMastery([q('2026-09-01T00:00:00Z', 10, 2), q('2026-09-03T00:00:00Z', 10, 10)]);
  const b = computeMastery([q('2026-09-03T00:00:00Z', 10, 10), q('2026-09-01T00:00:00Z', 10, 2)]);
  assert.deepEqual(a, b);
});

test('ungraded events do not distort accuracy but still count as review', () => {
  const m = computeMastery([q('2026-09-01T00:00:00Z', 4, 4), { ts: '2026-09-05T00:00:00Z', asked: 0 }]);
  assert.equal(m.accuracy, 1);
  assert.equal(m.attempts, 1);
});

test('nextReview spaces by mastery level', () => {
  for (let level = 0; level <= 5; level++) {
    const d = nextReview({ mastery: level, lastAccuracy: 0.8, lastReviewed: '2026-09-01T00:00:00Z' });
    const days = (new Date(d) - new Date('2026-09-01T00:00:00Z')) / 86400000;
    assert.equal(days, INTERVALS[level], `mastery ${level}`);
  }
});

test('a lapse resets to tomorrow regardless of mastery', () => {
  const d = nextReview({ mastery: 5, lastAccuracy: 0.4, lastReviewed: '2026-09-01T00:00:00Z' });
  assert.equal(d, '2026-09-02');
});

test('a clean sweep at high mastery earns an extension', () => {
  const plain = nextReview({ mastery: 4, lastAccuracy: 0.9, lastReviewed: '2026-09-01T00:00:00Z' });
  const perfect = nextReview({ mastery: 4, lastAccuracy: 1, lastReviewed: '2026-09-01T00:00:00Z' });
  assert.ok(new Date(perfect) > new Date(plain));
});

test('nextReview returns null without a review date or mastery', () => {
  assert.equal(nextReview({ mastery: null, lastReviewed: '2026-09-01T00:00:00Z' }), null);
  assert.equal(nextReview({ mastery: 3, lastReviewed: null }), null);
});

test('deriveTopics builds topic state from ingest and quiz events', async () => {
  const root = scratch();
  append(
    { type: 'ingest', class: '15-122', note: 'notes/a.md', topics: ['inv', 'big-o'] },
    root,
  );
  append(q('2026-09-10T00:00:00Z', 8, 4, ['exit condition']), root);
  append(q('2026-09-12T00:00:00Z', 8, 4, ['exit condition']), root);

  const d = await deriveTopics('15-122', root);
  assert.deepEqual([...d.keys()].sort(), ['big-o', 'inv']);

  const inv = d.get('inv');
  assert.equal(inv.attempts, 2);
  assert.deepEqual(inv.sources, ['notes/a.md']);
  assert.deepEqual(inv.confusions, ['exit condition'], 'missed twice => standing confusion');
  assert.equal(inv.last_reviewed, '2026-09-12');

  // Ingested but never quizzed.
  assert.equal(d.get('big-o').mastery, null);
  assert.equal(d.get('big-o').attempts, 0);
});

test('a concept missed only once is a slip, not a confusion', async () => {
  const root = scratch();
  append(q('2026-09-10T00:00:00Z', 8, 4, ['exit condition', 'metric']), root);
  append(q('2026-09-12T00:00:00Z', 8, 4, ['exit condition']), root);
  const d = await deriveTopics('15-122', root);
  assert.deepEqual(d.get('inv').confusions, ['exit condition']);
});

test('rebuild reconstructs derived frontmatter after topic files are deleted', async () => {
  const root = scratch();
  append({ type: 'ingest', class: '15-122', note: 'notes/a.md', topics: ['inv'] }, root);
  append(q('2026-09-10T00:00:00Z', 10, 9, ['metric']), root);
  append(q('2026-09-12T00:00:00Z', 10, 10), root);

  const first = await rebuildClass('15-122', root);
  assert.deepEqual(first.created, ['inv']);
  const before = readDoc(topicPath('15-122', 'inv', root)).data;
  assert.ok(before.mastery >= 4);

  fs.rmSync(topicPath('15-122', 'inv', root));
  const second = await rebuildClass('15-122', root);
  assert.deepEqual(second.created, ['inv']);
  const after = readDoc(topicPath('15-122', 'inv', root)).data;

  assert.deepEqual(after, before, 'derived state must survive losing the topic file');
});

test('rebuild preserves an existing body and unions sources', async () => {
  const root = scratch();
  const f = topicPath('15-122', 'inv', root);
  writeDoc(f, { class: '15-122', topic: 'inv', sources: ['notes/old.md'] }, '## Summary\n\nhand-written body');
  append({ type: 'ingest', class: '15-122', note: 'notes/new.md', topics: ['inv'] }, root);
  append(q('2026-09-10T00:00:00Z', 6, 3), root);

  const res = await rebuildClass('15-122', root);
  assert.deepEqual(res.updated, ['inv']);

  const doc = readDoc(f);
  assert.match(doc.body, /hand-written body/, 'body must not be clobbered');
  assert.deepEqual(doc.data.sources.sort(), ['notes/new.md', 'notes/old.md']);
  assert.equal(doc.data.attempts, 1);
});

test('dueTopics puts overdue before never-tested, weakest first', async () => {
  const root = scratch();
  append({ type: 'ingest', class: '15-122', note: 'n.md', topics: ['fresh'] }, root);
  append({ type: 'quiz', ts: '2026-01-01T00:00:00Z', class: '15-122', topic: 'weak', asked: 10, correct: 2 }, root);
  append({ type: 'quiz', ts: '2026-01-01T00:00:00Z', class: '15-122', topic: 'strong', asked: 20, correct: 20 }, root);

  const due = await dueTopics('15-122', root, new Date('2026-06-01T00:00:00Z'));
  const order = due.map((d) => d.topic);
  assert.equal(order[0], 'weak', 'weakest overdue topic first');
  assert.equal(order.at(-1), 'fresh', 'never-tested sorts after overdue');
});

test('dueTopics excludes topics not yet due', async () => {
  const root = scratch();
  append({ type: 'quiz', ts: '2026-06-01T00:00:00Z', class: '15-122', topic: 'recent', asked: 20, correct: 20 }, root);
  const due = await dueTopics('15-122', root, new Date('2026-06-02T00:00:00Z'));
  assert.deepEqual(due.map((d) => d.topic), []);
});
