import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ghostscriptAvailable,
  pageCount,
  pageToPng,
  allPagesToPng,
  inkFraction,
} from '../lib/pdfpage.js';
import { buildManifest, writeSheetPdf } from '../lib/sheet.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-pdf-'));

/**
 * Build a PDF whose page 2 carries a real /Ink annotation with an /AP
 * appearance stream — the structure Apple Markup writes when you draw with the
 * Pencil.
 *
 * This fixture exists because handwriting lives in annotations, not page
 * content. Page content always renders, so testing with content would pass
 * while the actual feature was broken. If a future change stops annotations
 * being drawn, the grader would silently report every answer as a blank page,
 * and this is the test that catches it.
 */
function annotatedPdf(pages = 3, inkPage = 2) {
  const objs = new Map();
  const strokes = ['2.5 w 0 0 0.75 RG'];
  for (let row = 0; row < 4; row++) {
    const y = 620 - row * 42;
    strokes.push(`80 ${y} m`);
    for (let i = 1; i < 34; i++) strokes.push(`${80 + i * 13} ${y + (i % 2 ? 9 : -7)} l`);
    strokes.push('S');
  }
  const ap = strokes.join('\n');

  objs.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  objs.set(
    4,
    '<< /Type /Annot /Subtype /Ink /Rect [70 460 600 650] /F 4 /C [0 0 0.75] ' +
      '/BS << /W 3 >> /InkList [[80 620 500 500]] /AP << /N 5 0 R >> >>',
  );
  objs.set(
    5,
    `<< /Type /XObject /Subtype /Form /BBox [70 460 600 650] /Length ${ap.length} >>\nstream\n${ap}\nendstream`,
  );

  const pageIds = [];
  let next = 6;
  for (let i = 1; i <= pages; i++) {
    const content = `BT /F1 12 Tf 60 740 Td (Q${i} of ${pages}) Tj ET\n`;
    const cid = next++;
    const pid = next++;
    objs.set(cid, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.set(
      pid,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R` +
        (i === inkPage ? ' /Annots [4 0 R]' : '') +
        ' >>',
    );
    pageIds.push(pid);
  }
  objs.set(2, `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pages} >>`);
  objs.set(1, '<< /Type /Catalog /Pages 2 0 R >>');

  let buf = Buffer.from('%PDF-1.7\n');
  const offsets = new Map();
  for (const num of [...objs.keys()].sort((a, b) => a - b)) {
    offsets.set(num, buf.length);
    buf = Buffer.concat([buf, Buffer.from(`${num} 0 obj\n${objs.get(num)}\nendobj\n`)]);
  }
  const xref = buf.length;
  const n = Math.max(...objs.keys()) + 1;
  let tail = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) {
    tail += `${String(offsets.get(i) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  tail += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const file = path.join(tmp(), 'annotated.pdf');
  fs.writeFileSync(file, Buffer.concat([buf, Buffer.from(tail)]));
  return file;
}

/** A plain generated worksheet, no annotations. */
function blankSheet(nQuestions = 3) {
  const m = buildManifest({
    class: '15-122',
    questions: Array.from({ length: nQuestions }, (_, i) => ({
      topic: `topic-${i + 1}`,
      question: `Question number ${i + 1}.`,
    })),
  });
  const res = writeSheetPdf(m, { dir: tmp() });
  assert.equal(res.ok, true, res.error);
  return res.pdf;
}

test('ghostscript is available', () => {
  assert.equal(ghostscriptAvailable(), true, 'gs is required for worksheet grading');
});

test('pageCount matches the number of questions', () => {
  assert.equal(pageCount(blankSheet(4)), 4);
});

test('pageToPng renders a requested page', () => {
  const res = pageToPng(blankSheet(3), 2);
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.statSync(res.file).size > 0);
});

test('pageToPng rejects bad input instead of returning a broken image', () => {
  const pdf = blankSheet(2);
  assert.equal(pageToPng(pdf, 99).ok, false, 'page beyond the end');
  assert.equal(pageToPng(pdf, 0).ok, false, 'pages are 1-based');
  assert.equal(pageToPng(pdf, 1.5).ok, false, 'must be an integer');
  assert.equal(pageToPng('/nonexistent.pdf', 1).ok, false);
});

test('allPagesToPng renders every page in order', () => {
  const res = allPagesToPng(blankSheet(3));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.total, 3);
  assert.deepEqual(res.pages.map((p) => p.page), [1, 2, 3]);
});

test('REGRESSION: ink annotations are rendered, not dropped', () => {
  // The crux of the feature. If this fails, handwriting is invisible and every
  // answer would be graded as a blank page.
  const pdf = annotatedPdf(3, 2);
  const inked = inkFraction(pdf, 2);
  const blank = inkFraction(pdf, 1);
  assert.ok(inked !== null && blank !== null, 'ink measurement failed');
  assert.ok(
    inked > blank * 5,
    `annotated page (${inked?.toFixed(4)}) must be far darker than a blank one (${blank?.toFixed(4)})`,
  );
});

test('ink is localised to the page it was drawn on', () => {
  // An off-by-one here would grade the wrong question, silently.
  const pdf = annotatedPdf(3, 2);
  const f = [1, 2, 3].map((p) => inkFraction(pdf, p));
  assert.ok(f[1] > f[0] && f[1] > f[2], `page 2 should be the only inked page: ${f.map((x) => x.toFixed(4))}`);
});

test('a freshly generated worksheet page reads as effectively blank', () => {
  // Establishes the baseline the live loop uses to say "not attempted"
  // rather than grading an unanswered page as wrong.
  const pdf = blankSheet(2);
  for (const p of [1, 2]) {
    const f = inkFraction(pdf, p);
    assert.ok(f !== null && f < 0.009, `page ${p} ink ${f?.toFixed(4)} should be under the blank ceiling`);
  }
});

test('inkFraction returns null for an unreadable file rather than throwing', () => {
  const bad = path.join(tmp(), 'notapdf.pdf');
  fs.writeFileSync(bad, 'this is not a pdf');
  assert.equal(inkFraction(bad, 1), null);
});
