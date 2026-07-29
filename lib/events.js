/**
 * events.js — the append-only event log.
 *
 * `vault/log/events.jsonl` is the single source of truth for everything that
 * happened. Topic mastery, class stats, and dashboards are all DERIVED caches
 * that can be thrown away and rebuilt from this file. Nothing in here ever
 * rewrites or deletes a line.
 *
 * One JSON object per line:
 *   {"ts":"2026-09-14T21:03:00.000Z","type":"quiz","class":"15-122",
 *    "topic":"invariants","asked":8,"correct":5,"missed":["..."]}
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { paths } from './vault.js';

export const EVENT_TYPES = ['ingest', 'quiz', 'session', 'exam', 'plan', 'reflect'];

/**
 * Append one event. Returns the stored event (with `ts` filled in).
 *
 * Uses a single atomic-ish appendFileSync of one line. POSIX guarantees
 * O_APPEND writes below PIPE_BUF land intact, so concurrent writers (watcher +
 * an interactive session) cannot interleave a line.
 */
export function append(event, root) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('append(event): event must be an object');
  }
  if (!event.type) throw new TypeError('append(event): event.type is required');
  if (!EVENT_TYPES.includes(event.type)) {
    throw new TypeError(
      `append(event): unknown type "${event.type}" (expected one of ${EVENT_TYPES.join(', ')})`,
    );
  }

  const stored = normalizePaths({ ts: event.ts ?? new Date().toISOString(), ...event });
  const file = paths(root).events;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const line = JSON.stringify(stored);
  if (line.includes('\n')) throw new Error('append(event): serialized event contains a newline');
  fs.appendFileSync(file, line + '\n', 'utf8');
  return stored;
}

const PATH_FIELDS = ['note', 'source', 'exam', 'file'];

/**
 * Force path fields to the class-relative form documented in SKILL.md.
 *
 * The log is append-only, so an inconsistent convention can never be cleaned
 * up after the fact — normalizing here means the rule is enforced rather than
 * merely documented, however the event was produced.
 */
function normalizePaths(event) {
  if (!event.class) return event;
  const prefix = `vault/classes/${event.class}/`;
  for (const field of PATH_FIELDS) {
    const v = event[field];
    if (typeof v !== 'string') continue;
    const cleaned = v.replace(/^\.\//, '');
    if (cleaned.startsWith(prefix)) event[field] = cleaned.slice(prefix.length);
    else if (cleaned.startsWith(`classes/${event.class}/`)) {
      event[field] = cleaned.slice(`classes/${event.class}/`.length);
    } else if (cleaned !== v) event[field] = cleaned;
  }
  return event;
}

/**
 * Stream every event, oldest first. Async so the log can grow past memory
 * without this becoming a liability.
 *
 * Malformed lines are skipped rather than thrown on — a half-written line from
 * a killed process must never make the whole log unreadable.
 */
export async function* stream(root) {
  const file = paths(root).events;
  if (!fs.existsSync(file)) return;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
}

/**
 * Read events matching a filter.
 *
 * @param {object} [filter]
 * @param {string|string[]} [filter.type]   event type(s)
 * @param {string} [filter.class]           class id
 * @param {string} [filter.topic]           topic slug
 * @param {string} [filter.since]           ISO date/timestamp, inclusive
 * @param {string} [filter.until]           ISO date/timestamp, exclusive
 * @param {number} [filter.limit]           keep only the most recent N
 */
export async function query(filter = {}, root) {
  const types = filter.type ? [].concat(filter.type) : null;
  const out = [];

  for await (const e of stream(root)) {
    if (types && !types.includes(e.type)) continue;
    if (filter.class && e.class !== filter.class) continue;
    if (filter.topic && e.topic !== filter.topic) continue;
    if (filter.since && e.ts < filter.since) continue;
    if (filter.until && e.ts >= filter.until) continue;
    out.push(e);
  }

  if (filter.limit != null && out.length > filter.limit) {
    return out.slice(-filter.limit);
  }
  return out;
}

/** Group events by a key (or key function). */
export function groupBy(events, key) {
  const fn = typeof key === 'function' ? key : (e) => e[key];
  const map = new Map();
  for (const e of events) {
    const k = fn(e);
    if (k === undefined || k === null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return map;
}

/**
 * Roll quiz/exam events up into per-topic performance.
 * This is the raw material lib/mastery.js turns into a review schedule.
 */
export async function topicStats(classId, root) {
  const events = await query({ type: ['quiz', 'exam'], class: classId }, root);
  const stats = new Map();

  for (const e of events) {
    if (!e.topic) continue;
    if (!stats.has(e.topic)) {
      stats.set(e.topic, {
        topic: e.topic,
        asked: 0,
        correct: 0,
        attempts: 0,
        missed: [],
        lastReviewed: null,
      });
    }
    const s = stats.get(e.topic);
    s.asked += e.asked ?? 0;
    s.correct += e.correct ?? 0;
    s.attempts += 1;
    if (Array.isArray(e.missed)) s.missed.push(...e.missed);
    if (!s.lastReviewed || e.ts > s.lastReviewed) s.lastReviewed = e.ts;
  }

  for (const s of stats.values()) {
    s.accuracy = s.asked > 0 ? s.correct / s.asked : null;
    // Most-repeated misses first — these are the standing misconceptions.
    const counts = new Map();
    for (const m of s.missed) counts.set(m, (counts.get(m) ?? 0) + 1);
    s.topMissed = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([concept, count]) => ({ concept, count }));
  }

  return stats;
}
