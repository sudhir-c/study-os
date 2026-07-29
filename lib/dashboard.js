/**
 * dashboard.js — one read-only snapshot of "where do I stand right now".
 *
 * Extracted so `studyos status` and the status line compute from identical
 * logic. They render very differently, but a dashboard that disagreed with the
 * status bar sitting three lines below it would make both untrustworthy.
 *
 * Everything here derives from the event log via lib/mastery.js, so a stale
 * topic file can't produce a wrong number.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  paths,
  projectRoot,
  listClasses,
  classPaths,
  readDoc,
} from './vault.js';
import { query } from './events.js';
import { dueTopics } from './mastery.js';

const DAY_MS = 86_400_000;

/** Exams within `withinDays`, soonest first, from schedule.md frontmatter. */
export function examsSoon(classId, root = projectRoot(), withinDays = 21, now = Date.now()) {
  const doc = readDoc(classPaths(classId, root).schedule);
  const exams = doc?.data?.exams;
  if (!Array.isArray(exams)) return [];

  return exams
    .filter((e) => e && e.date)
    .map((e) => ({ ...e, days: Math.ceil((new Date(e.date) - now) / DAY_MS) }))
    .filter((e) => Number.isFinite(e.days) && e.days >= 0 && e.days <= withinDays)
    .sort((a, b) => a.days - b.days);
}

/** Files awaiting ingest — top level of inbox/, ignoring _dirs and dotfiles. */
export function inboxItems(root = projectRoot()) {
  const dir = paths(root).inbox;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/** Topic files on disk, weakest first. Frontmatter only — no body parsing. */
export function listTopics(classId, root = projectRoot()) {
  const dir = classPaths(classId, root).topics;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ slug: f.replace(/\.md$/, ''), ...(readDoc(path.join(dir, f))?.data ?? {}) }))
    .sort((a, b) => (a.mastery ?? 9) - (b.mastery ?? 9));
}

/** Quiz accuracy over a trailing window. Null when nothing was asked. */
export async function accuracySince(classId, since, root = projectRoot()) {
  const recent = await query({ class: classId, since }, root);
  const quizzes = recent.filter((e) => e.type === 'quiz');
  const asked = quizzes.reduce((n, e) => n + (e.asked ?? 0), 0);
  const correct = quizzes.reduce((n, e) => n + (e.correct ?? 0), 0);
  return { events: recent.length, asked, correct, ratio: asked > 0 ? correct / asked : null };
}

/**
 * Which class is "current"?
 *
 * Nearest upcoming exam wins — that's what you're actually working toward.
 * Falling back to most-recently-touched keeps this useful before any syllabus
 * is uploaded, which is the normal state at the start of a term.
 */
export async function activeClass(root = projectRoot(), now = Date.now()) {
  const ids = listClasses(root);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];

  let soonest = null;
  for (const id of ids) {
    const next = examsSoon(id, root, 60, now)[0];
    if (next && (!soonest || next.days < soonest.days)) soonest = { id, days: next.days };
  }
  if (soonest) return soonest.id;

  const events = await query({}, root);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].class && ids.includes(events[i].class)) return events[i].class;
  }
  return ids[0];
}

/**
 * Everything the dashboard and status line need, in one pass.
 *
 * Never throws on an empty or partial vault — the status line runs on every
 * keystroke-ish event, and a stack trace rendered into the status bar would be
 * both useless and hard to escape from.
 *
 * @returns {Promise<{
 *   classId: string|null, title: string, topics: number,
 *   weakest: object|null, due: number, untested: number,
 *   exam: object|null, inbox: number, accuracy: object, empty: boolean
 * }>}
 */
export async function snapshot(root = projectRoot(), now = Date.now()) {
  const base = {
    classId: null,
    title: '',
    topics: 0,
    weakest: null,
    due: 0,
    untested: 0,
    exam: null,
    inbox: inboxItems(root).length,
    accuracy: { events: 0, asked: 0, correct: 0, ratio: null },
    empty: true,
  };

  try {
    const classId = await activeClass(root, now);
    if (!classId) return base;

    const topics = listTopics(classId, root);
    const dueList = await dueTopics(classId, root, new Date(now));
    const untested = dueList.filter((d) => d.mastery === null);

    return {
      ...base,
      classId,
      title: readDoc(classPaths(classId, root).meta)?.data?.title ?? '',
      topics: topics.length,
      // dueTopics() is already sorted weakest-first. When nothing is due at
      // all, fall back to the lowest-mastery topic on disk so the display
      // still points somewhere useful instead of going blank.
      weakest: dueList[0] ?? topics[0] ?? null,
      due: dueList.length - untested.length,
      untested: untested.length,
      exam: examsSoon(classId, root, 21, now)[0] ?? null,
      accuracy: await accuracySince(classId, new Date(now - 7 * DAY_MS).toISOString(), root),
      empty: false,
    };
  } catch {
    // A malformed topic file or half-written log line must not take down the
    // status bar. Degrade to the empty shape and let the next tick recover.
    return base;
  }
}
