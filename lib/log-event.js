#!/usr/bin/env node
/**
 * log-event.js — append an event to the log from the shell.
 *
 * Exists so agents have one unambiguous, validated way to write to
 * events.jsonl instead of hand-appending JSON lines (which risks a malformed
 * line in the one file that must stay readable).
 *
 * Usage:
 *   node lib/log-event.js '{"type":"quiz","class":"15-122","topic":"invariants",
 *                           "asked":8,"correct":5,"missed":["..."]}'
 *   echo '{"type":"ingest",...}' | node lib/log-event.js
 *
 * Accepts a single object or an array of objects. Prints the stored event(s).
 */

import fs from 'node:fs';
import { append, EVENT_TYPES } from './events.js';

const arg = process.argv[2];
let raw;

if (arg && arg !== '-') {
  raw = arg;
} else {
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
}

if (!raw.trim()) {
  console.error(
    `usage: node lib/log-event.js '<json>'\n\n` +
      `  Event types: ${EVENT_TYPES.join(', ')}\n` +
      `  Required: type. Conventional: class, topic.\n`,
  );
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error(`log-event: input is not valid JSON — ${e.message}`);
  process.exit(1);
}

const events = Array.isArray(parsed) ? parsed : [parsed];
const stored = [];
try {
  for (const e of events) stored.push(append(e));
} catch (e) {
  console.error(`log-event: ${e.message}`);
  process.exit(1);
}

for (const e of stored) console.log(JSON.stringify(e));
