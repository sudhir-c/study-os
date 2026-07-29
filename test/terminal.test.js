import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureVault } from '../lib/vault.js';
import { PALETTES, PALETTE_NAMES, pickPalette } from '../lib/terminal.js';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-term-'));
  ensureVault(root);
  return root;
}

/** WCAG relative luminance. */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Run fn with STUDYOS_THEME set, always restoring it afterwards. */
function withTheme(value, fn) {
  const saved = process.env.STUDYOS_THEME;
  if (value === undefined) delete process.env.STUDYOS_THEME;
  else process.env.STUDYOS_THEME = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.STUDYOS_THEME;
    else process.env.STUDYOS_THEME = saved;
  }
}

test('every palette defines background, text and accent as 6-digit hex', () => {
  assert.ok(PALETTE_NAMES.length >= 2, 'randomising over fewer than two is pointless');
  for (const name of PALETTE_NAMES) {
    const p = PALETTES[name];
    for (const key of ['background', 'text', 'accent']) {
      assert.match(p[key], /^#[0-9A-Fa-f]{6}$/, `${name}.${key} must be #RRGGBB`);
    }
  }
});

test('every palette has a genuinely dark background', () => {
  for (const name of PALETTE_NAMES) {
    const l = luminance(PALETTES[name].background);
    assert.ok(l < 0.05, `${name} background luminance ${l.toFixed(4)} is not dark`);
  }
});

test('every palette clears WCAG AAA for text and accent', () => {
  // This is the guard rail: a future palette that looks nice but is unreadable
  // fails here rather than in your eyes at 1am.
  for (const name of PALETTE_NAMES) {
    const p = PALETTES[name];
    const textRatio = contrast(p.text, p.background);
    const accentRatio = contrast(p.accent, p.background);
    assert.ok(textRatio >= 7, `${name} text contrast ${textRatio.toFixed(2)} < 7:1`);
    assert.ok(accentRatio >= 7, `${name} accent contrast ${accentRatio.toFixed(2)} < 7:1`);
  }
});

test('PALETTE_NAMES matches the palette table', () => {
  assert.deepEqual(PALETTE_NAMES.sort(), Object.keys(PALETTES).sort());
});

test('STUDYOS_THEME pins a specific palette', () => {
  const root = scratch();
  withTheme('teal', () => {
    for (let i = 0; i < 5; i++) assert.equal(pickPalette(root).name, 'teal');
  });
});

test('an unknown STUDYOS_THEME falls back to random rather than erroring', () => {
  const root = scratch();
  withTheme('chartreuse-explosion', () => {
    const p = pickPalette(root);
    assert.ok(PALETTE_NAMES.includes(p.name));
  });
});

test('pickPalette never returns the same palette twice in a row', () => {
  const root = scratch();
  withTheme(undefined, () => {
    let previous = null;
    for (let i = 0; i < 40; i++) {
      const p = pickPalette(root);
      assert.notEqual(p.name, previous, 'consecutive repeat defeats the randomisation');
      previous = p.name;
    }
  });
});

test('pickPalette returns the full colour set, not just a name', () => {
  const root = scratch();
  withTheme('navy', () => {
    const p = pickPalette(root);
    assert.equal(p.name, 'navy');
    assert.equal(p.background, PALETTES.navy.background);
    assert.equal(p.accent, PALETTES.navy.accent);
  });
});

test('pickPalette still works when the memo file cannot be read', () => {
  const root = scratch();
  withTheme(undefined, () => {
    const p = pickPalette(root, () => 0);
    assert.ok(PALETTE_NAMES.includes(p.name));
  });
});
