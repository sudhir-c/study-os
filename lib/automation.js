/**
 * automation.js — launchd agents for the watcher and the nightly review.
 *
 * launchd rather than a custom daemon: it survives reboots, needs nothing
 * installed, and `WatchPaths` gives us filesystem triggering without a polling
 * loop (fswatch isn't present on this machine anyway).
 *
 * Nothing here runs until the user explicitly calls `studyos automation
 * enable`. Background jobs that spend tokens should never be opted in for
 * someone.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, projectRoot } from './vault.js';

export const LABELS = {
  watch: 'com.studyos.watch',
  nightly: 'com.studyos.nightly',
};

const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

export function plistPath(which) {
  return path.join(AGENTS_DIR, `${LABELS[which]}.plist`);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plist({ label, programArgs, extra, root }) {
  const logFile = path.join(paths(root).log, 'automation.log');
  const args = programArgs.map((a) => `      <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(root)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin')}</string>
    <key>STUDYOS_HOME</key>
    <string>${xmlEscape(root)}</string>
  </dict>
${extra}
</dict>
</plist>
`;
}

/**
 * The watcher. `WatchPaths` fires on any change inside inbox/, which for a
 * multi-file drop means several near-simultaneous invocations — hence the
 * lockfile-and-settle wrapper in bin/studyos-watch.
 */
export function watchPlist(root = projectRoot()) {
  const p = paths(root);
  return plist({
    label: LABELS.watch,
    root,
    programArgs: [process.execPath, path.join(root, 'bin', 'studyos-watch')],
    extra: `  <key>WatchPaths</key>
  <array>
    <string>${xmlEscape(p.inbox)}</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>30</integer>`,
  });
}

/** The nightly review, at 23:00 local. */
export function nightlyPlist(root = projectRoot(), hour = 23, minute = 0) {
  return plist({
    label: LABELS.nightly,
    root,
    programArgs: [process.execPath, path.join(root, 'bin', 'studyos'), 'review', '--nightly'],
    extra: `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>`,
  });
}

function launchctl(...args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 501);

export function enable(which, root = projectRoot(), opts = {}) {
  const file = plistPath(which);
  const content =
    which === 'watch' ? watchPlist(root) : nightlyPlist(root, opts.hour ?? 23, opts.minute ?? 0);

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');

  // bootout first so re-enabling picks up a changed plist.
  launchctl('bootout', `gui/${uid()}/${LABELS[which]}`);
  const res = launchctl('bootstrap', `gui/${uid()}`, file);
  if (res.status !== 0) {
    return { ok: false, file, error: (res.stderr || res.stdout || '').trim() };
  }
  return { ok: true, file };
}

export function disable(which) {
  const file = plistPath(which);
  launchctl('bootout', `gui/${uid()}/${LABELS[which]}`);
  if (fs.existsSync(file)) fs.rmSync(file);
  return { ok: true, file };
}

export function status(which) {
  const file = plistPath(which);
  const installed = fs.existsSync(file);
  const res = launchctl('print', `gui/${uid()}/${LABELS[which]}`);
  return { installed, loaded: res.status === 0, file };
}
