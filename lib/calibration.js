/**
 * calibration.js — does `mastery` actually predict exam performance?
 *
 * Every other number in study-os leans on the mastery estimator: what's due,
 * what the planner prioritises, what the quizmaster targets. Until now nothing
 * checked it against ground truth. This module does exactly one thing —
 * compare what mastery predicted *going into* an exam against what you actually
 * scored on that exam, per topic.
 *
 * The comparison is only meaningful if the prediction excludes the exam itself,
 * so every predicted value is computed from `deriveTopics(..., { until })` at
 * the exam's timestamp. Including the exam would make the estimator look
 * perfectly calibrated by construction.
 *
 * Report-only by design: nothing here feeds back into mastery. Mastery stays a
 * pure function of the event log, and a handful of exam results is nowhere near
 * enough evidence to start bending it.
 */

import { query } from './events.js';
import { deriveTopics } from './mastery.js';
import { projectRoot, slugify } from './vault.js';

/** Headline bias is withheld below this many topic results. */
export const MIN_N_FOR_BIAS = 5;

/** A per-level row shows a bias figure only with at least this many results. */
export const MIN_N_PER_LEVEL = 3;

/** Within this many percentage points, call it well calibrated rather than biased. */
export const WELL_CALIBRATED_BAND = 10;

export const SERIES = ['real', 'practice'];

/**
 * Accuracy the estimator implies for a mastery level.
 *
 * No invented curve: computeMastery() is `round(weightedAccuracy * 5)` capped,
 * so the inverse is simply `mastery / 5`. The expected value falls out of how
 * mastery is already defined, which means there is nothing here to argue with.
 */
export function expectedAccuracy(mastery) {
  return (mastery / 5) * 100;
}

function summarize(rows) {
  if (rows.length === 0) return { mean: null, meanError: null };
  const mean = rows.reduce((s, r) => s + r.actual, 0) / rows.length;
  const meanError = rows.reduce((s, r) => s + r.error, 0) / rows.length;
  return { mean, meanError };
}

/** Empty series shape, so callers never branch on undefined. */
function emptySeries(kind) {
  return {
    kind,
    rows: [],
    byLevel: [],
    bias: null,
    n: 0,
    sufficient: false,
    exams: [],
    untestedGoingIn: [],
  };
}

/**
 * Compare predicted mastery against actual exam performance.
 *
 * @param {string} classId
 * @param {string} [root]
 * @returns {Promise<{real: object, practice: object}>} one series per exam kind
 */
export async function calibrate(classId, root = projectRoot()) {
  const events = await query({ type: 'exam', class: classId }, root);

  // Mastery-as-of is the expensive part; distinct exam timestamps are few, so
  // compute each snapshot once rather than per topic row.
  const snapshots = new Map();
  const masteryAt = async (ts) => {
    if (!snapshots.has(ts)) snapshots.set(ts, await deriveTopics(classId, root, { until: ts }));
    return snapshots.get(ts);
  };

  const series = Object.fromEntries(SERIES.map((k) => [k, emptySeries(k)]));

  for (const e of events) {
    // An exam event without a topic or without questions carries no signal.
    // (The pre-fix schema produced exactly these — see the note in SKILL.md.)
    if (!e.topic || !(e.asked > 0)) continue;

    // Unlabelled events are treated as practice: the conservative reading,
    // since practice tests are the weaker evidence and must never be silently
    // promoted into the real-exam series.
    const kind = e.kind === 'real' ? 'real' : 'practice';
    const s = series[kind];

    const topic = slugify(e.topic);
    if (e.exam && !s.exams.includes(e.exam)) s.exams.push(e.exam);

    const actual = (e.correct ?? 0) / e.asked * 100;
    const predicted = (await masteryAt(e.ts)).get(topic)?.mastery ?? null;

    if (predicted === null) {
      // Examined on material never tested beforehand. Not a calibration data
      // point — there was no prediction to check — but a finding in its own
      // right, and one that would otherwise vanish from the denominator.
      s.untestedGoingIn.push({ topic, exam: e.exam ?? null, actual, asked: e.asked });
      continue;
    }

    const expected = expectedAccuracy(predicted);
    s.rows.push({
      exam: e.exam ?? null,
      ts: e.ts,
      topic,
      predicted,
      expected,
      actual,
      error: actual - expected,
      asked: e.asked,
      missed: e.missed ?? [],
    });
  }

  for (const s of Object.values(series)) {
    s.n = s.rows.length;
    s.sufficient = s.n >= MIN_N_FOR_BIAS;

    const { meanError } = summarize(s.rows);
    s.bias = meanError;

    const levels = new Map();
    for (const r of s.rows) {
      if (!levels.has(r.predicted)) levels.set(r.predicted, []);
      levels.get(r.predicted).push(r);
    }
    s.byLevel = [...levels.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([predicted, rows]) => {
        const { mean, meanError: err } = summarize(rows);
        return {
          predicted,
          expected: expectedAccuracy(predicted),
          actual: mean,
          error: err,
          n: rows.length,
          // Withheld at low n: a single hard question would otherwise read as
          // a systematic bias.
          reliable: rows.length >= MIN_N_PER_LEVEL,
        };
      });
  }

  return series;
}

/** Human label for a bias figure, or null when it isn't worth naming. */
export function describeBias(bias) {
  if (bias === null) return null;
  if (Math.abs(bias) <= WELL_CALIBRATED_BAND) return 'well calibrated';
  return bias < 0 ? 'overconfident' : 'underconfident';
}
