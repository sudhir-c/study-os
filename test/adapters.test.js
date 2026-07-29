import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureVault, paths } from '../lib/vault.js';
import { htmlToMarkdown } from '../lib/adapters/apple-notes.js';
import { sync as folderSync, SUPPORTED } from '../lib/adapters/folder.js';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-adapters-'));
  ensureVault(root);
  return root;
}

function sourceDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyos-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// --- Apple Notes HTML conversion ------------------------------------------

test('htmlToMarkdown handles the subset Apple Notes emits', () => {
  const html =
    '<div><h1>Lecture 4</h1></div><div>A <b>loop invariant</b> is a <i>property</i>.</div>' +
    '<div><br></div><ul><li>holds before</li><li>holds after</li></ul>' +
    '<div>Use <code>lo + (hi-lo)/2</code></div>';
  const md = htmlToMarkdown(html);

  assert.match(md, /# Lecture 4/);
  assert.match(md, /\*\*loop invariant\*\*/);
  assert.match(md, /_property_/);
  assert.match(md, /- holds before/);
  assert.match(md, /- holds after/);
  assert.match(md, /`lo \+ \(hi-lo\)\/2`/);
  assert.doesNotMatch(md, /<[a-z]/i, 'no tags should survive');
});

test('htmlToMarkdown decodes entities without mangling math', () => {
  const md = htmlToMarkdown('<div>if n &lt; 5 &amp;&amp; n &gt; 0 then&nbsp;stop</div>');
  assert.equal(md, 'if n < 5 && n > 0 then stop');
});

test('htmlToMarkdown collapses blank runs and trims', () => {
  const md = htmlToMarkdown('<div><br></div><div><br></div><div>a</div><div><br></div><div><br></div><div>b</div>');
  assert.equal(md, 'a\n\nb');
});

test('htmlToMarkdown returns empty string for a drawing-only note', () => {
  // The handwriting case: Apple Notes gives back a body with no text content.
  assert.equal(htmlToMarkdown('<div><br></div>'), '');
  assert.equal(htmlToMarkdown(''), '');
});

// --- Folder adapter --------------------------------------------------------

test('folder sync copies supported files and ignores the rest', () => {
  const root = scratch();
  const src = sourceDir({ 'a.md': 'a', 'b.pdf': 'b', 'c.docx': 'c', 'd.txt': 'd' });

  const res = folderSync(src, { root });
  assert.equal(res.ok, true);
  assert.deepEqual(res.copied.sort(), ['a.md', 'b.pdf', 'd.txt']);
  assert.deepEqual(res.ignored, ['c.docx']);

  const inbox = fs.readdirSync(paths(root).inbox).filter((f) => !f.startsWith('_'));
  assert.deepEqual(inbox.sort(), ['a.md', 'b.pdf', 'd.txt']);
});

test('folder sync is idempotent across runs', () => {
  const root = scratch();
  const src = sourceDir({ 'a.md': 'a' });

  assert.equal(folderSync(src, { root }).copied.length, 1);
  const second = folderSync(src, { root });
  assert.equal(second.copied.length, 0);
  assert.deepEqual(second.skipped, ['a.md']);
});

test('folder sync re-copies a file whose contents changed', () => {
  const root = scratch();
  const src = sourceDir({ 'a.md': 'original' });
  folderSync(src, { root });

  // Different size and a later mtime => new fingerprint.
  fs.writeFileSync(path.join(src, 'a.md'), 'changed substantially');
  const res = folderSync(src, { root });
  assert.deepEqual(res.copied, ['a.md']);
});

test('folder sync flattens subdirectories so names cannot collide', () => {
  const root = scratch();
  const src = sourceDir({ 'week3/lecture.pdf': 'x', 'week4/lecture.pdf': 'y' });

  const res = folderSync(src, { root, recursive: true });
  assert.deepEqual(res.copied.sort(), ['week3-lecture.pdf', 'week4-lecture.pdf']);
  assert.equal(fs.readFileSync(path.join(paths(root).inbox, 'week3-lecture.pdf'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(paths(root).inbox, 'week4-lecture.pdf'), 'utf8'), 'y');
});

test('folder sync ignores subdirectories unless recursive', () => {
  const root = scratch();
  const src = sourceDir({ 'top.md': 'a', 'sub/deep.md': 'b' });
  assert.deepEqual(folderSync(src, { root }).copied, ['top.md']);
});

test('folder sync applies a prefix', () => {
  const root = scratch();
  const src = sourceDir({ 'a.md': 'a' });
  assert.deepEqual(folderSync(src, { root, prefix: 'gn' }).copied, ['gn-a.md']);
});

test('folder sync dry run reports without writing or recording state', () => {
  const root = scratch();
  const src = sourceDir({ 'a.md': 'a' });

  const dry = folderSync(src, { root, dryRun: true });
  assert.deepEqual(dry.copied, ['a.md']);
  assert.equal(fs.existsSync(path.join(paths(root).inbox, 'a.md')), false);

  // State was not recorded, so a real run still copies it.
  assert.deepEqual(folderSync(src, { root }).copied, ['a.md']);
});

test('folder sync errors clearly on a bad path', () => {
  const root = scratch();
  assert.match(folderSync('/nonexistent-xyz', { root }).error, /No such directory/);
  const f = path.join(scratch(), 'file.txt');
  fs.writeFileSync(f, 'x');
  assert.match(folderSync(f, { root }).error, /Not a directory/);
});

test('folder sync skips dotfiles', () => {
  const root = scratch();
  const src = sourceDir({ '.DS_Store': 'x', 'a.md': 'a' });
  assert.deepEqual(folderSync(src, { root }).copied, ['a.md']);
});

test('SUPPORTED covers the formats ingest advertises', () => {
  for (const ext of ['.pdf', '.png', '.jpg', '.jpeg', '.heic', '.md', '.txt']) {
    assert.ok(SUPPORTED.includes(ext), `${ext} should be supported`);
  }
});
