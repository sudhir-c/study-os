/**
 * vault.js — filesystem conventions for the study-os vault.
 *
 * The vault is the product; this module is the only place that knows where
 * things live and how frontmatter is encoded. Everything else (CLI, agents,
 * commands) goes through here so the layout can change in exactly one place.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/**
 * Project root. Overridable with STUDYOS_HOME so the CLI works from any cwd
 * and so tests can point at a scratch vault.
 */
export function projectRoot() {
  if (process.env.STUDYOS_HOME) return path.resolve(process.env.STUDYOS_HOME);
  // lib/ lives directly under the project root.
  return path.resolve(import.meta.dirname, '..');
}

export function paths(root = projectRoot()) {
  const vault = path.join(root, 'vault');
  const log = path.join(vault, 'log');
  return {
    root,
    vault,
    classes: path.join(vault, 'classes'),
    log,
    events: path.join(log, 'events.jsonl'),
    daily: path.join(log, 'daily'),
    inbox: path.join(root, 'inbox'),
    processed: path.join(root, 'inbox', '_processed'),
  };
}

// ---------------------------------------------------------------------------
// Frontmatter
//
// Deliberately NOT full YAML. Values are parsed as JSON first, falling back to
// a raw trimmed string. That makes arrays/numbers/booleans exact and
// round-trippable without a YAML dependency or a hand-rolled YAML parser's
// edge cases. Block lists (`- item`) are accepted on read for tolerance —
// agents sometimes write them — but are always re-serialized as JSON arrays.
// ---------------------------------------------------------------------------

const FM_DELIM = '---';

/** Parse a value: JSON if it parses, otherwise the raw trimmed string. */
function parseValue(raw) {
  const s = raw.trim();
  if (s === '') return '';
  try {
    return JSON.parse(s);
  } catch {
    // Strip matching single quotes, which JSON rejects but humans write.
    if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1);
    return s;
  }
}

/** Serialize a value into the restricted subset the parser accepts. */
function stringifyValue(v) {
  if (typeof v === 'string') {
    // Quote only when a bare string would be ambiguous (parse to something else,
    // or contain structural characters). Keeps common cases readable.
    const bare = v.trim();
    let ambiguous = bare !== v || bare === '' || /[:#\n]/.test(bare);
    if (!ambiguous) {
      try {
        JSON.parse(bare); // parses as non-string => must quote
        ambiguous = true;
      } catch {
        /* stays bare */
      }
    }
    return ambiguous ? JSON.stringify(v) : bare;
  }
  return JSON.stringify(v);
}

/**
 * Split a document into `{ data, body }`.
 * Documents without frontmatter yield `{ data: {}, body: <whole text> }`.
 */
export function parseFrontmatter(text) {
  const normalized = text.replace(/^﻿/, '');
  if (!normalized.startsWith(FM_DELIM)) return { data: {}, body: normalized };

  const lines = normalized.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FM_DELIM) {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: normalized }; // unterminated => not frontmatter

  const data = {};
  let currentListKey = null;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    // Block-list continuation: "  - value"
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentListKey) {
      data[currentListKey].push(parseValue(listItem[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (rawValue.trim() === '') {
      // Either an empty value or the header of a block list; assume list and
      // collapse to '' at the end if nothing followed.
      data[key] = [];
      currentListKey = key;
    } else {
      data[key] = parseValue(stripComment(rawValue));
      currentListKey = null;
    }
  }

  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n/, '') };
}

/** Strip a trailing ` # comment`, but never inside a quoted string or array. */
function stripComment(raw) {
  let inString = false;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"' && raw[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === '#' && depth === 0 && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/** Render `{ data, body }` back into a document string. */
export function stringifyFrontmatter(data, body = '') {
  const keys = Object.keys(data);
  if (keys.length === 0) return body.endsWith('\n') || body === '' ? body : body + '\n';
  const lines = keys.map((k) => `${k}: ${stringifyValue(data[k])}`);
  const trimmedBody = body.replace(/^\n+/, '');
  return `${FM_DELIM}\n${lines.join('\n')}\n${FM_DELIM}\n\n${trimmedBody}${
    trimmedBody.endsWith('\n') ? '' : '\n'
  }`;
}

// ---------------------------------------------------------------------------
// Document IO
// ---------------------------------------------------------------------------

/** Read a markdown doc. Returns null if it does not exist. */
export function readDoc(file) {
  if (!fs.existsSync(file)) return null;
  return parseFrontmatter(fs.readFileSync(file, 'utf8'));
}

/** Write a markdown doc, creating parent directories as needed. */
export function writeDoc(file, data, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyFrontmatter(data, body), 'utf8');
  return file;
}

/**
 * Merge new frontmatter keys into an existing doc without touching its body.
 * Creates the doc if absent. This is the accumulate-don't-overwrite primitive
 * that keeps per-class memory growing across sessions.
 */
export function patchDoc(file, patch, fallbackBody = '') {
  const doc = readDoc(file) ?? { data: {}, body: fallbackBody };
  return writeDoc(file, { ...doc.data, ...patch }, doc.body);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

export function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Local (not UTC) calendar date — study days follow the user's clock. */
export function today(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Class + topic layout
// ---------------------------------------------------------------------------

export function classDir(classId, root = projectRoot()) {
  return path.join(paths(root).classes, classId);
}

export function classPaths(classId, root = projectRoot()) {
  const dir = classDir(classId, root);
  return {
    dir,
    meta: path.join(dir, 'class.md'),
    schedule: path.join(dir, 'schedule.md'),
    topics: path.join(dir, 'topics'),
    notes: path.join(dir, 'notes'),
    sources: path.join(dir, 'sources'),
    exams: path.join(dir, 'exams'),
  };
}

export function topicPath(classId, topic, root = projectRoot()) {
  return path.join(classPaths(classId, root).topics, `${slugify(topic)}.md`);
}

export function notePath(classId, date, title, root = projectRoot()) {
  return path.join(classPaths(classId, root).notes, `${date}-${slugify(title)}.md`);
}

/** Every registered class id (directories under vault/classes containing class.md). */
export function listClasses(root = projectRoot()) {
  const dir = paths(root).classes;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'class.md')))
    .map((e) => e.name)
    .sort();
}

/**
 * Resolve a user-typed class reference to a canonical id.
 * Matches exact id, case-insensitive id, declared aliases, then unique prefix.
 * Returns null when nothing matches, or throws on an ambiguous prefix.
 */
export function resolveClass(input, root = projectRoot()) {
  const ids = listClasses(root);
  if (ids.includes(input)) return input;

  const needle = String(input).toLowerCase();
  const ci = ids.find((id) => id.toLowerCase() === needle);
  if (ci) return ci;

  for (const id of ids) {
    const doc = readDoc(classPaths(id, root).meta);
    const aliases = doc?.data?.aliases;
    if (Array.isArray(aliases) && aliases.some((a) => String(a).toLowerCase() === needle)) {
      return id;
    }
  }

  const prefix = ids.filter((id) => id.toLowerCase().replace(/-/g, '').startsWith(needle.replace(/-/g, '')));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new Error(`Ambiguous class "${input}" — matches: ${prefix.join(', ')}`);
  }
  return null;
}

/** Create the directory skeleton and class.md for a new class. */
export function createClass(classId, meta = {}, root = projectRoot()) {
  const p = classPaths(classId, root);
  for (const d of [p.dir, p.topics, p.notes, p.sources, p.exams]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(p.meta)) {
    writeDoc(
      p.meta,
      {
        class: classId,
        title: meta.title ?? classId,
        term: meta.term ?? '',
        instructor: meta.instructor ?? '',
        aliases: meta.aliases ?? [],
        created: today(),
        ...meta.extra,
      },
      CLASS_TEMPLATE,
    );
  }
  return p;
}

const CLASS_TEMPLATE = `# Overview

<!-- What this course is, how it's assessed. Filled in from the syllabus. -->

## Grading

<!-- Weight of each component. Drives study prioritization. -->

## Exam format

<!-- Question styles, what's allowed, how long. Learned from practice tests. -->

## Recurring patterns

<!-- Question types this instructor returns to. Grows as you take practice tests. -->

## My standing misconceptions

<!-- Things you have gotten wrong more than once. The analyst appends here. -->
`;

/** Ensure the base vault directories exist. Idempotent. */
export function ensureVault(root = projectRoot()) {
  const p = paths(root);
  for (const d of [p.vault, p.classes, p.log, p.daily, p.inbox, p.processed]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(p.events)) fs.writeFileSync(p.events, '', 'utf8');
  return p;
}
