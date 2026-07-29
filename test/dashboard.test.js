import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureVault, createClass, writeDoc, classPaths, paths } from '../lib/vault.js';
import { append } from '../lib/events.js';
import { rebuildClass } from '../lib/mastery.js';
import {
  snapshot,
  examsSoon,
  inboxItems,
  listTopics,
  accuracySince,
  activeClass,
} from '../lib/dashboard.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const ago = (n) => new Date(NOW - n * DAY).toISOString();
const inDays = (n) => new Date(NOW + n * DAY).toISOString().slice(0, 10);

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-dash-'));
  ensureVault(root);
  return root;
}

// --- examsSoon -------------------------------------------------------------

test('examsSoon returns upcoming exams inside the window, soonest first', () => {
  const root = scratch();
  createClass('15-122', {}, root);
  writeDoc(
    classPaths('15-122', root).schedule,
    {
      class: '15-122',
      exams: [
        { name: 'Final', date: inDays(14) },
        { name: 'Midterm', date: inDays(3) },
        { name: 'Ancient', date: inDays(-5) },
        { name: 'Far off', date: inDays(60) },
      ],
    },
    '',
  );

  const got = examsSoon('15-122', root, 21, NOW);
  assert.deepEqual(got.map((e) => e.name), ['Midterm', 'Final']);
  assert.equal(got[0].days, 3);
});

test('examsSoon is empty when there is no schedule at all', () => {
  const root = scratch();
  createClass('15-122', {}, root);
  assert.deepEqual(examsSoon('15-122', root, 21, NOW), []);
});

// --- inboxItems ------------------------------------------------------------

test('inboxItems counts only loose files, ignoring dotfiles and subdirectories', () => {
  const root = scratch();
  const inbox = paths(root).inbox;
  fs.writeFileSync(path.join(inbox, 'scan.pdf'), 'x');
  fs.writeFileSync(path.join(inbox, 'notes.md'), 'x');
  fs.writeFileSync(path.join(inbox, '.lock'), 'x');
  fs.mkdirSync(path.join(inbox, '_processed'), { recursive: true });

  assert.deepEqual(inboxItems(root).sort(), ['notes.md', 'scan.pdf']);
});

// --- accuracySince ---------------------------------------------------------

test('accuracySince returns null ratio when nothing was asked', async () => {
  const root = scratch();
  createClass('15-122', {}, root);
  // ts must be pinned inside the window: NOW is synthetic, so an event stamped
  // with the real clock would fall outside it.
  append({ type: 'session', ts: ago(2), class: '15-122', minutes: 30 }, root);
  const acc = await accuracySince('15-122', ago(7), root);
  assert.equal(acc.ratio, null);
  assert.equal(acc.events, 1);
});

test('accuracySince aggregates only quiz events in the window', async () => {
  const root = scratch();
  createClass('15-122', {}, root);
  append({ type: 'quiz', ts: ago(2), class: '15-122', topic: 't', asked: 10, correct: 8 }, root);
  append({ type: 'quiz', ts: ago(30), class: '15-122', topic: 't', asked: 10, correct: 0 }, root);

  const acc = await accuracySince('15-122', ago(7), root);
  assert.equal(acc.asked, 10);
  assert.equal(acc.correct, 8);
  assert.ok(Math.abs(acc.ratio - 0.8) < 1e-9, 'old quiz must not drag the ratio down');
});

// --- activeClass -----------------------------------------------------------

test('activeClass prefers the class with the nearest upcoming exam', async () => {
  const root = scratch();
  createClass('15-122', {}, root);
  createClass('21-241', {}, root);
  writeDoc(classPaths('15-122', root).schedule, { exams: [{ name: 'M', date: inDays(20) }] }, '');
  writeDoc(classPaths('21-241', root).schedule, { exams: [{ name: 'M', date: inDays(2) }] }, '');

  assert.equal(await activeClass(root, NOW), '21-241');
});

test('activeClass falls back to the most recently touched class', async () => {
  const root = scratch();
  createClass('15-122', {}, root);
  createClass('21-241', {}, root);
  append({ type: 'quiz', ts: ago(5), class: '15-122', topic: 't', asked: 1, correct: 1 }, root);
  append({ type: 'quiz', ts: ago(1), class: '21-241', topic: 't', asked: 1, correct: 1 }, root);

  assert.equal(await activeClass(root, NOW), '21-241');
});

test('activeClass returns null when no classes are registered', async () => {
  assert.equal(await activeClass(scratch(), NOW), null);
});

// --- snapshot --------------------------------------------------------------

test('snapshot on an empty vault is the empty shape, not a throw', async () => {
  const s = await snapshot(scratch(), NOW);
  assert.equal(s.empty, true);
  assert.equal(s.classId, null);
  assert.equal(s.weakest, null);
  assert.equal(s.inbox, 0);
});

test('snapshot reports due, untested, exam, inbox and accuracy together', async () => {
  const root = scratch();
  createClass('15-122', { title: 'Imperative Computation' }, root);
  writeDoc(classPaths('15-122', root).schedule, { exams: [{ name: 'Midterm', date: inDays(4) }] }, '');

  append({ type: 'ingest', class: '15-122', note: 'notes/a.md', topics: ['inv', 'sorting'] }, root);
  // Two sittings ~9-11d ago: mastery lands mid-range and the review is overdue.
  append({ type: 'quiz', ts: ago(11), class: '15-122', topic: 'inv', asked: 8, correct: 5 }, root);
  append({ type: 'quiz', ts: ago(9), class: '15-122', topic: 'inv', asked: 8, correct: 5 }, root);
  append({ type: 'quiz', ts: ago(2), class: '15-122', topic: 'recent', asked: 10, correct: 8 }, root);
  await rebuildClass('15-122', root);

  fs.writeFileSync(path.join(paths(root).inbox, 'scan.pdf'), 'x');

  const s = await snapshot(root, NOW);
  assert.equal(s.classId, '15-122');
  assert.equal(s.title, 'Imperative Computation');
  assert.equal(s.empty, false);
  assert.equal(s.exam.name, 'Midterm');
  assert.equal(s.exam.days, 4);
  assert.equal(s.inbox, 1);
  assert.equal(s.weakest.topic, 'inv', 'overdue topic outranks the never-tested one');
  assert.ok(s.due >= 1);
  assert.ok(s.untested >= 1, 'sorting was ingested but never quizzed');
  assert.ok(Math.abs(s.accuracy.ratio - 0.8) < 1e-9);
});

test('snapshot falls back to the lowest-mastery topic when nothing is due', async () => {
  const root = scratch();
  createClass('15-122', {}, root);
  // Quizzed just now, so its next_review is in the future — nothing is due.
  append({ type: 'quiz', ts: new Date(NOW).toISOString(), class: '15-122', topic: 'fresh', asked: 10, correct: 10 }, root);
  await rebuildClass('15-122', root);

  const s = await snapshot(root, NOW);
  assert.equal(s.due, 0);
  assert.ok(s.weakest, 'must still point somewhere rather than going blank');
  assert.equal(s.weakest.topic ?? s.weakest.slug, 'fresh');
});

test('snapshot survives a malformed topic file', async () => {
  const root = scratch();
  createClass('15-122', {}, root);
  fs.writeFileSync(path.join(classPaths('15-122', root).topics, 'broken.md'), '---\nnot: [valid\n');
  const s = await snapshot(root, NOW);
  assert.equal(typeof s.empty, 'boolean', 'returned a usable shape rather than throwing');
});

test('listTopics sorts weakest first and tolerates a missing directory', () => {
  const root = scratch();
  createClass('15-122', {}, root);
  const dir = classPaths('15-122', root).topics;
  writeDoc(path.join(dir, 'strong.md'), { topic: 'strong', mastery: 5 }, '');
  writeDoc(path.join(dir, 'weak.md'), { topic: 'weak', mastery: 1 }, '');

  assert.deepEqual(listTopics('15-122', root).map((t) => t.topic), ['weak', 'strong']);
  assert.deepEqual(listTopics('99-999', root), []);
});
