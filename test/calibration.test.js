import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureVault, createClass } from '../lib/vault.js';
import { append } from '../lib/events.js';
import { deriveTopics } from '../lib/mastery.js';
import {
  calibrate,
  expectedAccuracy,
  describeBias,
  MIN_N_FOR_BIAS,
  MIN_N_PER_LEVEL,
} from '../lib/calibration.js';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-cal-'));
  ensureVault(root);
  createClass('15-122', {}, root);
  return root;
}

const quiz = (root, ts, topic, asked, correct) =>
  append({ type: 'quiz', ts, class: '15-122', topic, asked, correct }, root);

const exam = (root, ts, topic, asked, correct, kind = 'real', name = 'exams/mid') =>
  append({ type: 'exam', ts, class: '15-122', exam: name, kind, topic, asked, correct }, root);

/** Three separate sittings, so the topic reaches a real (uncapped) mastery. */
function establish(root, topic, correctPer10) {
  for (const d of ['2026-09-01', '2026-09-08', '2026-09-15']) {
    quiz(root, `${d}T00:00:00Z`, topic, 10, correctPer10);
  }
}

// --- the bug this feature exists to fix ------------------------------------

test('REGRESSION: an exam event with a singular topic feeds mastery', async () => {
  // Before this feature an exam event carried `topics[]` and no asked/correct,
  // so a logged exam reached the estimator not at all.
  const root = scratch();
  exam(root, '2026-10-01T00:00:00Z', 'inv', 8, 4);

  const derived = await deriveTopics('15-122', root);
  assert.ok(derived.has('inv'), 'exam result must reach the estimator');
  assert.equal(derived.get('inv').attempts, 1);
  assert.notEqual(derived.get('inv').mastery, null);
});

test('REGRESSION: the old exam shape contributes nothing and is not counted', async () => {
  const root = scratch();
  append(
    { type: 'exam', class: '15-122', exam: 'exams/old', score: 34, max: 50, topics: ['inv'] },
    root,
  );
  const series = await calibrate('15-122', root);
  assert.equal(series.real.n, 0, 'an event with no topic/asked carries no signal');
  assert.equal(series.practice.n, 0);
});

// --- time bounding ---------------------------------------------------------

test('prediction excludes the exam itself and everything after it', async () => {
  const root = scratch();
  establish(root, 'inv', 6); // ~mastery 3 going in
  exam(root, '2026-10-01T00:00:00Z', 'inv', 10, 3);
  // A perfect quiz AFTER the exam must not inflate the prediction retroactively.
  quiz(root, '2026-11-01T00:00:00Z', 'inv', 10, 10);

  const series = await calibrate('15-122', root);
  const row = series.real.rows.find((r) => r.topic === 'inv');
  const preExam = await deriveTopics('15-122', root, { until: '2026-10-01T00:00:00Z' });

  assert.equal(row.predicted, preExam.get('inv').mastery);
  assert.ok(row.predicted <= 3, `expected the pre-exam view, got ${row.predicted}`);
});

test('deriveTopics without a bound still sees every event', async () => {
  const root = scratch();
  quiz(root, '2026-09-01T00:00:00Z', 'inv', 10, 5);
  quiz(root, '2026-11-01T00:00:00Z', 'inv', 10, 10);
  const all = await deriveTopics('15-122', root);
  assert.equal(all.get('inv').attempts, 2, 'unbounded call must be unchanged');
});

// --- the arithmetic --------------------------------------------------------

test('expected accuracy inverts the mastery definition', () => {
  assert.equal(expectedAccuracy(5), 100);
  assert.equal(expectedAccuracy(4), 80);
  assert.equal(expectedAccuracy(0), 0);
});

test('error is actual minus expected, negative when overconfident', async () => {
  const root = scratch();
  establish(root, 'inv', 8); // mastery 4 -> expects 80%
  exam(root, '2026-10-01T00:00:00Z', 'inv', 10, 5); // actually 50%

  const { real } = await calibrate('15-122', root);
  const row = real.rows[0];
  assert.equal(row.predicted, 4);
  assert.equal(row.expected, 80);
  assert.equal(row.actual, 50);
  assert.equal(row.error, -30);
  assert.equal(describeBias(row.error), 'overconfident');
});

test('describeBias treats a small gap as well calibrated', () => {
  assert.equal(describeBias(-4), 'well calibrated');
  assert.equal(describeBias(9), 'well calibrated');
  assert.equal(describeBias(-25), 'overconfident');
  assert.equal(describeBias(25), 'underconfident');
  assert.equal(describeBias(null), null);
});

// --- honesty gates ---------------------------------------------------------

test('bias is withheld below the evidence threshold', async () => {
  const root = scratch();
  establish(root, 'inv', 8);
  exam(root, '2026-10-01T00:00:00Z', 'inv', 10, 5);

  const { real } = await calibrate('15-122', root);
  assert.equal(real.n, 1);
  assert.equal(real.sufficient, false, `n=1 must not clear the n>=${MIN_N_FOR_BIAS} bar`);
  assert.notEqual(real.bias, null, 'still computed, just not presentable');
});

test('bias becomes reportable once enough topics have results', async () => {
  const root = scratch();
  const topics = ['a', 'b', 'c', 'd', 'e'];
  for (const t of topics) establish(root, t, 8);
  for (const t of topics) exam(root, '2026-10-01T00:00:00Z', t, 10, 5);

  const { real } = await calibrate('15-122', root);
  assert.equal(real.n, MIN_N_FOR_BIAS);
  assert.equal(real.sufficient, true);
  assert.ok(real.bias < 0, 'scoring 50% against an 80% expectation is overconfidence');
});

test('a per-level row is unreliable until it has enough results', async () => {
  const root = scratch();
  for (const t of ['a', 'b', 'c']) establish(root, t, 8); // all mastery 4
  exam(root, '2026-10-01T00:00:00Z', 'a', 10, 5);
  exam(root, '2026-10-01T00:00:00Z', 'b', 10, 5);

  let { real } = await calibrate('15-122', root);
  assert.equal(real.byLevel[0].n, 2);
  assert.equal(real.byLevel[0].reliable, false, `n=2 < ${MIN_N_PER_LEVEL}`);

  exam(root, '2026-10-01T00:00:00Z', 'c', 10, 5);
  ({ real } = await calibrate('15-122', root));
  assert.equal(real.byLevel[0].n, 3);
  assert.equal(real.byLevel[0].reliable, true);
});

// --- series separation -----------------------------------------------------

test('practice and real results are never pooled', async () => {
  const root = scratch();
  establish(root, 'inv', 8);
  exam(root, '2026-09-20T00:00:00Z', 'inv', 10, 10, 'practice');
  exam(root, '2026-10-01T00:00:00Z', 'inv', 10, 4, 'real');

  const series = await calibrate('15-122', root);
  assert.equal(series.real.n, 1);
  assert.equal(series.practice.n, 1);
  assert.ok(series.practice.bias > 0, 'aced the practice test');
  assert.ok(series.real.bias < 0, 'underperformed the real exam');
});

test('an unlabelled exam is treated as practice, the weaker evidence', async () => {
  const root = scratch();
  establish(root, 'inv', 8);
  append(
    { type: 'exam', ts: '2026-10-01T00:00:00Z', class: '15-122', topic: 'inv', asked: 10, correct: 5 },
    root,
  );
  const series = await calibrate('15-122', root);
  assert.equal(series.real.n, 0, 'must not be promoted into the real series');
  assert.equal(series.practice.n, 1);
});

// --- coverage findings -----------------------------------------------------

test('a topic examined but never tested is reported, not dropped', async () => {
  const root = scratch();
  establish(root, 'known', 8);
  exam(root, '2026-10-01T00:00:00Z', 'known', 10, 8);
  exam(root, '2026-10-01T00:00:00Z', 'surprise', 4, 1);

  const { real } = await calibrate('15-122', root);
  assert.equal(real.n, 1, 'no prediction existed, so it is not a calibration row');
  assert.deepEqual(real.untestedGoingIn.map((u) => u.topic), ['surprise']);
  assert.equal(real.untestedGoingIn[0].actual, 25);
});

// --- robustness ------------------------------------------------------------

test('fractional partial credit produces a clean integer mastery', async () => {
  const root = scratch();
  exam(root, '2026-10-01T00:00:00Z', 'inv', 6, 3.5);
  const derived = await deriveTopics('15-122', root);
  const m = derived.get('inv').mastery;
  assert.ok(Number.isInteger(m), `mastery must stay an integer, got ${m}`);
  assert.ok(!Number.isNaN(m));
});

test('exam events with no questions are ignored rather than dividing by zero', async () => {
  const root = scratch();
  establish(root, 'inv', 8);
  exam(root, '2026-10-01T00:00:00Z', 'inv', 0, 0);
  const { real } = await calibrate('15-122', root);
  assert.equal(real.n, 0);
  assert.equal(real.untestedGoingIn.length, 0);
});

test('calibrate on a class with no exams returns empty series, not a throw', async () => {
  const { real, practice } = await calibrate('15-122', scratch());
  assert.equal(real.n, 0);
  assert.equal(practice.n, 0);
  assert.deepEqual(real.rows, []);
  assert.equal(real.bias, null);
  assert.equal(real.sufficient, false);
});

test('exams are grouped and listed once each', async () => {
  const root = scratch();
  establish(root, 'a', 8);
  establish(root, 'b', 8);
  exam(root, '2026-10-01T00:00:00Z', 'a', 10, 5, 'real', 'exams/midterm-1');
  exam(root, '2026-10-01T00:00:00Z', 'b', 10, 5, 'real', 'exams/midterm-1');
  exam(root, '2026-11-01T00:00:00Z', 'a', 10, 5, 'real', 'exams/final');

  const { real } = await calibrate('15-122', root);
  assert.deepEqual(real.exams.sort(), ['exams/final', 'exams/midterm-1']);
});
