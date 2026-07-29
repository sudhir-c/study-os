/**
 * mastery.js — turns the event log into a mastery estimate and a review date.
 *
 * Everything here is a pure function of events plus an "as of" date. Topic
 * frontmatter is a cache of these outputs, never an input, which is what makes
 * `studyos rebuild` able to reconstruct state from the log alone.
 *
 * The model is SM-2 in spirit, simplified: rather than asking you to
 * self-rate recall, it derives a 0–5 mastery from how you actually performed
 * on generated questions, then spaces the next review off that.
 */

import { query } from './events.js';
import {
  classPaths,
  topicPath,
  readDoc,
  writeDoc,
  patchDoc,
  slugify,
  projectRoot,
} from './vault.js';
import fs from 'node:fs';

const DAY_MS = 86_400_000;

/** Review interval in days for each mastery level, index 0–5. */
export const INTERVALS = [1, 2, 4, 7, 14, 30];

/**
 * Older attempts count for less. 0.6 per step back means the last three
 * attempts carry ~80% of the weight — recent enough to track real improvement,
 * long enough that one lucky quiz doesn't declare mastery.
 */
const RECENCY_DECAY = 0.6;

/**
 * You cannot demonstrate high mastery on a handful of questions, and you
 * cannot demonstrate *durable* mastery in a single sitting at all — recall
 * across separate sessions is the entire premise of spaced repetition.
 *
 * So evidence is capped on two independent axes and the tighter one wins:
 * breadth (how many questions) and persistence (how many distinct sittings).
 * A perfect 10-question quiz in one sitting reads as "promising" (3), not
 * "handles novel multi-step applications" (4).
 */
function confidenceCap(totalAsked, sittings) {
  let byVolume;
  if (totalAsked < 3) byVolume = 2;
  else if (totalAsked < 6) byVolume = 3;
  else if (totalAsked < 12) byVolume = 4;
  else byVolume = 5;

  let bySittings;
  if (sittings <= 1) bySittings = 3;
  else if (sittings === 2) bySittings = 4;
  else bySittings = 5;

  return Math.min(byVolume, bySittings);
}

/** Distinct calendar days on which a topic was tested. */
function countSittings(graded) {
  return new Set(graded.map((e) => String(e.ts).slice(0, 10))).size;
}

/**
 * Derive mastery from a topic's graded attempts.
 *
 * @param {Array} attempts quiz/exam events for one topic, any order
 * @returns {{mastery:number|null, accuracy:number|null, weighted:number|null,
 *            asked:number, correct:number, attempts:number, lastReviewed:string|null,
 *            lastAccuracy:number|null, cap:number}}
 */
export function computeMastery(attempts) {
  const graded = attempts
    .filter((e) => (e.asked ?? 0) > 0)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const base = {
    mastery: null,
    accuracy: null,
    weighted: null,
    asked: 0,
    correct: 0,
    attempts: graded.length,
    sittings: 0,
    lastReviewed: attempts.reduce((m, e) => (!m || e.ts > m ? e.ts : m), null),
    lastAccuracy: null,
    cap: 0,
  };
  if (graded.length === 0) return base;

  let asked = 0;
  let correct = 0;
  let wCorrect = 0;
  let wAsked = 0;

  graded.forEach((e, i) => {
    const stepsBack = graded.length - 1 - i;
    const w = RECENCY_DECAY ** stepsBack;
    asked += e.asked;
    correct += e.correct ?? 0;
    wAsked += w * e.asked;
    wCorrect += w * (e.correct ?? 0);
  });

  const last = graded.at(-1);
  const weighted = wAsked > 0 ? wCorrect / wAsked : null;
  const sittings = countSittings(graded);
  const cap = confidenceCap(asked, sittings);

  return {
    ...base,
    mastery: Math.min(Math.round(weighted * 5), cap),
    accuracy: correct / asked,
    weighted,
    asked,
    correct,
    sittings,
    lastAccuracy: (last.correct ?? 0) / last.asked,
    lastReviewed: graded.at(-1).ts,
    cap,
  };
}

/**
 * When to review next.
 *
 * A lapse — scoring under half on the most recent attempt — resets to
 * tomorrow regardless of accumulated mastery, because a topic you just failed
 * is not a topic to revisit in three weeks. A clean sweep at mastery 3+ earns
 * a 1.3x extension.
 *
 * @returns {string|null} YYYY-MM-DD, or null when there is nothing to schedule
 */
export function nextReview({ mastery, lastAccuracy, lastReviewed }) {
  if (mastery === null || mastery === undefined || !lastReviewed) return null;

  let days = INTERVALS[Math.max(0, Math.min(5, mastery))];
  if (lastAccuracy !== null && lastAccuracy !== undefined) {
    if (lastAccuracy < 0.5) days = 1;
    else if (lastAccuracy === 1 && mastery >= 3) days = Math.round(days * 1.3);
  }

  const from = new Date(lastReviewed);
  if (Number.isNaN(from.getTime())) return null;
  return new Date(from.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Full derived state for every topic of a class, computed from events only.
 *
 * @returns {Map<string, object>} topic slug → derived fields
 */
export async function deriveTopics(classId, root = projectRoot(), { until } = {}) {
  // `until` (exclusive ISO timestamp) reconstructs mastery as it stood at a
  // past moment. Calibration needs this: comparing an exam result against a
  // mastery figure that already includes that exam would be circular and
  // would always look perfectly calibrated.
  const events = await query(until ? { class: classId, until } : { class: classId }, root);
  const derived = new Map();

  const touch = (slug) => {
    if (!derived.has(slug)) {
      derived.set(slug, {
        class: classId,
        topic: slug,
        attempts: 0,
        sources: [],
        confusions: [],
        mastery: null,
        last_reviewed: null,
        next_review: null,
      });
    }
    return derived.get(slug);
  };

  // Ingest events establish which topics exist and which notes feed them.
  const byTopic = new Map();
  for (const e of events) {
    if (e.type === 'ingest') {
      for (const t of e.topics ?? []) {
        const slug = slugify(t);
        const d = touch(slug);
        if (e.note && !d.sources.includes(e.note)) d.sources.push(e.note);
      }
      continue;
    }
    if ((e.type === 'quiz' || e.type === 'exam') && e.topic) {
      const slug = slugify(e.topic);
      touch(slug);
      if (!byTopic.has(slug)) byTopic.set(slug, []);
      byTopic.get(slug).push(e);
    }
  }

  for (const [slug, attempts] of byTopic) {
    const d = touch(slug);
    const m = computeMastery(attempts);
    d.mastery = m.mastery;
    d.attempts = m.attempts;
    d.last_reviewed = m.lastReviewed ? m.lastReviewed.slice(0, 10) : null;
    d.next_review = nextReview({
      mastery: m.mastery,
      lastAccuracy: m.lastAccuracy,
      lastReviewed: m.lastReviewed,
    });

    // A concept missed more than once is a standing confusion, not a slip.
    const counts = new Map();
    for (const e of attempts) {
      for (const miss of e.missed ?? []) counts.set(miss, (counts.get(miss) ?? 0) + 1);
    }
    d.confusions = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([concept]) => concept);
  }

  return derived;
}

/**
 * Write derived state into topic frontmatter.
 *
 * Bodies are left alone — they come from notes and are NOT reconstructible
 * from the event log. A topic file that no longer exists is recreated as a
 * frontmatter-only stub whose `sources` point at the notes needed to refill
 * the body.
 *
 * @returns {{updated:string[], created:string[]}}
 */
export async function rebuildClass(classId, root = projectRoot()) {
  const derived = await deriveTopics(classId, root);
  const updated = [];
  const created = [];

  for (const [slug, d] of derived) {
    const file = topicPath(classId, slug, root);
    const patch = {
      class: d.class,
      topic: d.topic,
      mastery: d.mastery,
      attempts: d.attempts,
      last_reviewed: d.last_reviewed,
      next_review: d.next_review,
      confusions: d.confusions,
    };

    const existing = readDoc(file);
    if (existing) {
      // Union sources so a note recorded only in frontmatter isn't dropped.
      const merged = [...new Set([...(existing.data.sources ?? []), ...d.sources])];
      patchDoc(file, { ...patch, sources: merged });
      updated.push(slug);
    } else {
      writeDoc(file, { ...patch, sources: d.sources }, STUB_BODY(d));
      created.push(slug);
    }
  }

  return { updated, created };
}

const STUB_BODY = (d) => `## Summary

<!-- Rebuilt from events.jsonl. The body is not reconstructible from the log —
     refill it from the source notes listed in \`sources\` above. -->

${d.sources.length ? d.sources.map((s) => `- [ ] re-read \`${s}\``).join('\n') : '- [ ] no source notes recorded'}

## Where I go wrong

${d.confusions.length ? d.confusions.map((c) => `- ${c}`).join('\n') : '<!-- filled in by quizzing -->'}
`;

/**
 * Topics due for review, weakest first.
 *
 * Topics never quizzed are included — an untested topic is exactly what you
 * should be testing — but sort after genuinely overdue ones.
 */
export async function dueTopics(classId, root = projectRoot(), asOf = new Date()) {
  const derived = await deriveTopics(classId, root);
  const todayStr = asOf.toISOString().slice(0, 10);

  // Include topic files that exist on disk but have no events yet.
  const dir = classPaths(classId, root).topics;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const slug = f.replace(/\.md$/, '');
      if (!derived.has(slug)) {
        const doc = readDoc(`${dir}/${f}`);
        derived.set(slug, {
          class: classId,
          topic: slug,
          mastery: doc?.data?.mastery ?? null,
          attempts: doc?.data?.attempts ?? 0,
          next_review: doc?.data?.next_review ?? null,
          confusions: doc?.data?.confusions ?? [],
          sources: doc?.data?.sources ?? [],
          last_reviewed: doc?.data?.last_reviewed ?? null,
        });
      }
    }
  }

  const due = [...derived.values()].filter(
    (d) => d.next_review === null || d.next_review <= todayStr,
  );

  return due.sort((a, b) => {
    const am = a.mastery ?? -1;
    const bm = b.mastery ?? -1;
    const aNever = a.next_review === null;
    const bNever = b.next_review === null;
    if (aNever !== bNever) return aNever ? 1 : -1; // overdue before never-tested
    if (am !== bm) return am - bm; // weakest first
    return String(a.next_review ?? '').localeCompare(String(b.next_review ?? ''));
  });
}
