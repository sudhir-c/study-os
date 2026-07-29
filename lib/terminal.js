/**
 * terminal.js — recolour Terminal.app while a StudyOS session is running.
 *
 * The single biggest "this isn't a coding tool" signal is the window itself.
 * Claude Code can restyle its own status bar, but the surrounding chrome —
 * background, text colour, cursor, title — belongs to the terminal emulator,
 * so that's where this reaches.
 *
 * Everything here is best-effort and reversible:
 *  - Apple Terminal only. Any other emulator is a silent no-op, never an error.
 *  - The previous profile name is recorded to disk before switching, so
 *    `studyos theme restore` can recover after a SIGKILL that skips the
 *    normal restore path.
 *  - If the custom profile can't be created (AppleScript across macOS versions
 *    is not something to bet on), we fall back to a stock profile that ships
 *    with macOS. Recolouring still happens; only the exact palette is lost.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, projectRoot } from './vault.js';

export const PROFILE = 'StudyOS';

/**
 * Fallbacks in preference order, all shipped with macOS. Dark-on-light or
 * strongly tinted, so any of them reads as visibly different from the default
 * "Basic" profile.
 */
const STOCK_FALLBACKS = ['Novel', 'Homebrew', 'Ocean', 'Pro'];

/** AppleScript colours are 16-bit per channel. */
const rgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  const to16 = (b) => Math.round((b / 255) * 65535);
  return [to16((n >> 16) & 255), to16((n >> 8) & 255), to16(n & 255)];
};

/**
 * Curated dark palettes, one picked at random per launch.
 *
 * Hand-tuned rather than randomly generated: a random RGB background produces
 * unreadable text about as often as not. Each entry pairs a near-black tinted
 * background with a light text colour of the same temperature and a single
 * saturated accent for bold text and the cursor.
 *
 * Measured contrast against their own background: text ranges 13.80–14.30:1
 * and the accent 7.41–11.38:1, so every pairing clears WCAG AAA (7:1) no
 * matter which one comes up. Covered by a test so a future palette can't be
 * added below that bar.
 */
export const PALETTES = {
  indigo: { background: '#12141F', text: '#E8E3D5', accent: '#F0C674' },
  forest: { background: '#0F1A14', text: '#DCE5DA', accent: '#8FD694' },
  plum: { background: '#1A121F', text: '#E6DEE8', accent: '#C792EA' },
  teal: { background: '#0D1A1C', text: '#D8E8E6', accent: '#5FD7C7' },
  oxblood: { background: '#1C1214', text: '#EDE0E0', accent: '#E88B8B' },
  navy: { background: '#0E1621', text: '#DDE4EE', accent: '#7FB3E8' },
  espresso: { background: '#1A1512', text: '#EAE0D5', accent: '#D9A05B' },
  slate: { background: '#14171A', text: '#DDE3E8', accent: '#9AB8D0' },
};

export const PALETTE_NAMES = Object.keys(PALETTES);

/** Where the last-used palette is remembered, purely to avoid repeats. */
function paletteMemoPath(root) {
  return path.join(paths(root).log, '.terminal-palette');
}

/**
 * Choose a palette for this session.
 *
 * STUDYOS_THEME pins one by name. Otherwise random, excluding whichever ran
 * last — with eight options a naive pick repeats about one launch in eight,
 * which reads as the randomisation being broken rather than as chance.
 */
export function pickPalette(root = projectRoot(), rand = Math.random) {
  const pinned = process.env.STUDYOS_THEME;
  if (pinned && PALETTES[pinned]) return { name: pinned, ...PALETTES[pinned] };

  let previous = null;
  try {
    previous = fs.readFileSync(paletteMemoPath(root), 'utf8').trim();
  } catch {
    /* first run, or the memo was cleaned up */
  }

  const choices = PALETTE_NAMES.filter((n) => n !== previous);
  const pool = choices.length ? choices : PALETTE_NAMES;
  const name = pool[Math.floor(rand() * pool.length) % pool.length];

  try {
    fs.mkdirSync(path.dirname(paletteMemoPath(root)), { recursive: true });
    fs.writeFileSync(paletteMemoPath(root), name, 'utf8');
  } catch {
    /* the memo is an anti-repeat nicety, not a requirement */
  }
  return { name, ...PALETTES[name] };
}

/**
 * Restyle the StudyOS profile in place.
 *
 * Only ever touches our own profile — the stock ones belong to the user and a
 * fallback launch must not permanently recolour "Novel".
 */
export function applyPalette(palette) {
  if (!isAppleTerminal() || !profileExists(PROFILE)) return false;
  const bg = rgb(palette.background);
  const fg = rgb(palette.text);
  const ac = rgb(palette.accent);

  return osa(`
tell application "Terminal"
  tell settings set "${PROFILE}"
    set background color to {${bg.join(', ')}}
    set normal text color to {${fg.join(', ')}}
    set bold text color to {${ac.join(', ')}}
    set cursor color to {${ac.join(', ')}}
  end tell
end tell`).ok;
}

export function isAppleTerminal() {
  return process.env.TERM_PROGRAM === 'Apple_Terminal';
}

function osa(script) {
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    return { ok: false, error: ((res.stderr ?? '') || res.error?.message || '').trim() };
  }
  return { ok: true, out: (res.stdout ?? '').trim() };
}

/** Name of the profile the front window is currently using. */
export function currentProfile() {
  if (!isAppleTerminal()) return null;
  const r = osa('tell application "Terminal" to return name of current settings of front window');
  return r.ok && r.out ? r.out : null;
}

export function profileExists(name) {
  if (!isAppleTerminal()) return false;
  const r = osa(`tell application "Terminal" to return (exists settings set "${name}")`);
  return r.ok && r.out === 'true';
}

/** Switch the front window. Returns true if the switch took effect. */
export function switchProfile(name) {
  if (!isAppleTerminal() || !name) return false;
  const r = osa(
    `tell application "Terminal" to set current settings of front window to settings set "${name}"`,
  );
  return r.ok;
}

/**
 * Create the StudyOS profile and style it.
 *
 * `make new settings set` rather than `duplicate` — duplicating a settings set
 * fails with "Some parameter is missing for duplicate" (-1701) regardless of
 * the destination clause, verified on this machine. `make new` works and the
 * colour properties read back correctly afterwards.
 */
export function createProfile() {
  if (!isAppleTerminal()) return { ok: false, error: 'not Apple Terminal' };
  if (profileExists(PROFILE)) return { ok: true, created: false };

  const p = PALETTES.indigo; // seed colours; activate() re-rolls per launch
  const bg = rgb(p.background);
  const fg = rgb(p.text);
  const ac = rgb(p.accent);

  const script = `
tell application "Terminal"
  make new settings set with properties {name:"${PROFILE}"}
  tell settings set "${PROFILE}"
    set background color to {${bg.join(', ')}}
    set normal text color to {${fg.join(', ')}}
    set bold text color to {${ac.join(', ')}}
    set cursor color to {${ac.join(', ')}}
    set font name to "Menlo"
    set font size to 14
  end tell
  return name of settings set "${PROFILE}"
end tell`;

  const r = osa(script);
  if (r.ok && profileExists(PROFILE)) return { ok: true, created: true };
  return { ok: false, error: r.error || 'profile did not appear after creation' };
}

/** Remove the StudyOS profile. Used by `studyos theme uninstall`. */
export function removeProfile() {
  if (!isAppleTerminal()) return false;
  if (!profileExists(PROFILE)) return true;
  return osa(`tell application "Terminal" to delete settings set "${PROFILE}"`).ok;
}

/** First stock profile that actually exists on this machine. */
export function stockFallback() {
  return STOCK_FALLBACKS.find((n) => profileExists(n)) ?? null;
}

/**
 * The profile to switch into: the custom one if we can build it, otherwise a
 * stock one. Recolouring the window matters more than the exact palette.
 */
export function resolveProfile() {
  if (!isAppleTerminal()) return null;
  if (profileExists(PROFILE)) return PROFILE;
  const made = createProfile();
  if (made.ok && profileExists(PROFILE)) return PROFILE;
  return stockFallback();
}

// ---------------------------------------------------------------------------
// Persisted previous-profile state, so a hard kill is recoverable
// ---------------------------------------------------------------------------

function statePath(root) {
  return path.join(paths(root).log, '.terminal-state.json');
}

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Switch into the StudyOS look, recording what to go back to.
 * @returns {{active: boolean, profile: string|null, previous: string|null}}
 */
export function activate(root = projectRoot()) {
  if (!isAppleTerminal()) return { active: false, profile: null, previous: null, palette: null };

  const previous = currentProfile();
  const profile = resolveProfile();
  if (!profile || profile === previous) return { active: false, profile, previous, palette: null };

  // Re-roll the colours before switching, so the change is already applied when
  // the window flips rather than visibly repainting a moment later. Only our
  // own profile is restyled; a stock fallback is left exactly as the user has it.
  let palette = null;
  if (profile === PROFILE) {
    palette = pickPalette(root);
    applyPalette(palette);
  }

  if (!switchProfile(profile)) return { active: false, profile, previous, palette };

  try {
    fs.mkdirSync(path.dirname(statePath(root)), { recursive: true });
    fs.writeFileSync(statePath(root), JSON.stringify({ previous, pid: process.pid }), 'utf8');
  } catch {
    /* state file is a convenience for `theme restore`, not required */
  }
  return { active: true, profile, previous, palette };
}

/**
 * Go back to the recorded profile. Idempotent — safe to call from both the
 * normal exit path and a signal handler, and safe to call when nothing is
 * currently overridden.
 */
export function deactivate(previous, root = projectRoot()) {
  if (!isAppleTerminal()) return false;
  const target = previous ?? readState(root)?.previous;
  if (!target) return false;

  const ok = switchProfile(target);
  try {
    fs.rmSync(statePath(root), { force: true });
  } catch {
    /* best effort */
  }
  return ok;
}

export function themeStatus(root = projectRoot()) {
  let lastPalette = null;
  try {
    lastPalette = fs.readFileSync(paletteMemoPath(root), 'utf8').trim() || null;
  } catch {
    /* never launched yet */
  }
  return {
    supported: isAppleTerminal(),
    terminal: process.env.TERM_PROGRAM ?? 'unknown',
    installed: isAppleTerminal() ? profileExists(PROFILE) : false,
    current: currentProfile(),
    pendingRestore: readState(root)?.previous ?? null,
    lastPalette,
    pinned: PALETTES[process.env.STUDYOS_THEME ?? ''] ? process.env.STUDYOS_THEME : null,
  };
}
