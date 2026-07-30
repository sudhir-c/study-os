/**
 * pdfpage.js — turn one page of a PDF into an image the grader can look at.
 *
 * This exists because handwriting lives in PDF *annotations*, and how reliably
 * those render depends on the reader. Rasterising to pixels removes the
 * question entirely: whatever is drawn on the page is in the image.
 *
 * Ghostscript's `png16m` device is used directly rather than splitting the page
 * out with `pdfwrite` first. That ordering is deliberate — pdfwrite is known to
 * drop annotations when it rewrites a PDF, which would silently erase exactly
 * the ink we are trying to read, and produce a confident "you left it blank"
 * instead of an error.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/** Rendering resolution. 150dpi is legible for handwriting without huge files. */
export const DEFAULT_DPI = 150;

export function ghostscriptAvailable() {
  const r = spawnSync('gs', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/** Total pages in a PDF, or null if it can't be determined. */
export function pageCount(pdf) {
  const r = spawnSync(
    'gs',
    [
      '-q',
      '-dNODISPLAY',
      '-dNOSAFER',
      '-c',
      `(${pdf}) (r) file runpdfbegin pdfpagecount = quit`,
    ],
    { encoding: 'utf8' },
  );
  if (r.error || r.status !== 0) return null;
  const n = parseInt((r.stdout ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Render one page to a PNG.
 *
 * `-dShowAnnots` defaults on in Ghostscript 10.x, so ink annotations are drawn
 * into the output. It is passed explicitly anyway: this is the single behaviour
 * the whole feature depends on and it should not be left to a default that a
 * future version might flip.
 *
 * @returns {{ok: true, file: string} | {ok: false, error: string}}
 */
export function pageToPng(pdf, page, { dpi = DEFAULT_DPI, outDir } = {}) {
  if (!fs.existsSync(pdf)) return { ok: false, error: `no such PDF: ${pdf}` };
  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, error: `page must be a positive integer, got ${page}` };
  }

  const dir = outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-page-'));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.basename(pdf, '.pdf')}-p${page}.png`);

  const r = spawnSync(
    'gs',
    [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=png16m',
      '-dShowAnnots=true',
      `-r${dpi}`,
      `-dFirstPage=${page}`,
      `-dLastPage=${page}`,
      `-sOutputFile=${out}`,
      pdf,
    ],
    { encoding: 'utf8' },
  );

  if (r.error) {
    return {
      ok: false,
      error: r.error.code === 'ENOENT' ? 'ghostscript (gs) not found on PATH' : r.error.message,
    };
  }
  if (r.status !== 0) return { ok: false, error: (r.stderr ?? '').trim() || `gs exited ${r.status}` };
  if (!fs.existsSync(out)) return { ok: false, error: 'gs reported success but wrote no file' };
  // A page that rendered to almost nothing usually means the page number was
  // out of range; gs is happy to produce an empty image in that case.
  if (fs.statSync(out).size === 0) return { ok: false, error: 'rendered page was empty' };

  return { ok: true, file: out };
}

/** Render every page. Returns one entry per page, in order. */
export function allPagesToPng(pdf, opts = {}) {
  const total = pageCount(pdf);
  if (total === null) return { ok: false, error: 'could not read page count' };
  const dir = opts.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-sheet-'));

  const pages = [];
  for (let p = 1; p <= total; p++) {
    const res = pageToPng(pdf, p, { ...opts, outDir: dir });
    if (!res.ok) return { ok: false, error: `page ${p}: ${res.error}` };
    pages.push({ page: p, file: res.file });
  }
  return { ok: true, total, pages, dir };
}

/**
 * Rough ink detector: how much of the page is non-white?
 *
 * Used to tell "not attempted" apart from "attempted but unreadable" before
 * spending a model call, and to catch the case where sync delivered the
 * original blank worksheet rather than the annotated one. Deliberately crude —
 * it decides whether to *ask*, never whether an answer is correct.
 *
 * Implemented with `gs` writing a tiny greyscale PGM, so there is no image
 * library dependency.
 *
 * @returns {number|null} fraction of dark pixels, or null if it can't be measured
 */
export function inkFraction(pdf, page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-ink-'));
  const out = path.join(dir, 'p.pgm');
  const r = spawnSync(
    'gs',
    [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=pgmraw',
      '-dShowAnnots=true',
      '-r36', // tiny: we only need a coverage estimate
      `-dFirstPage=${page}`,
      `-dLastPage=${page}`,
      `-sOutputFile=${out}`,
      pdf,
    ],
    { encoding: 'utf8' },
  );
  if (r.error || r.status !== 0 || !fs.existsSync(out)) return null;

  const buf = fs.readFileSync(out);
  // PGM raw header: P5 <w> <h> <maxval>\n then binary samples.
  let offset = 0;
  let fields = 0;
  while (fields < 4 && offset < buf.length) {
    while (offset < buf.length && /\s/.test(String.fromCharCode(buf[offset]))) offset++;
    if (String.fromCharCode(buf[offset]) === '#') {
      while (offset < buf.length && buf[offset] !== 0x0a) offset++;
      continue;
    }
    while (offset < buf.length && !/\s/.test(String.fromCharCode(buf[offset]))) offset++;
    fields++;
  }
  offset++; // single whitespace byte after the header

  let dark = 0;
  let total = 0;
  for (let i = offset; i < buf.length; i++) {
    total++;
    if (buf[i] < 200) dark++;
  }
  return total > 0 ? dark / total : null;
}
