---
description: Grade handwritten answers on a worksheet against its manifest
argument-hint: <class> [--sheet slug] [--pages 3] [--live]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Grade handwritten work on a worksheet.

Arguments: $ARGUMENTS

Read `.claude/skills/study-os/SKILL.md` first for the event schema.

## Steps

### 1. Load the manifest

```bash
node --input-type=module -e '
const s=await import("./lib/sheet.js");
const m=s.listManifests("15-122")[0];        // newest, or match --sheet
console.log(JSON.stringify({manifest:m,file:s.resolveSheetFile(m)},null,1));
'
```

The manifest tells you, for each page: the topic, the question asked, and what a
correct answer must contain. `resolveSheetFile` finds the annotated PDF in the
synced folder, tolerating apps that save a renamed copy.

If the file is missing, the iPad's edit hasn't synced. Say so and stop — do not
grade the blank original.

### 2. Read each page

Rasterise the page and read the image. **Use the rasteriser, not the PDF
directly** — handwriting lives in PDF annotations, and rendering to pixels is
what guarantees the ink is visible:

```bash
node --input-type=module -e '
const p=await import("./lib/pdfpage.js");
console.log(JSON.stringify(p.pageToPng("<sheet.pdf>", 3)));
console.log("ink:", p.inkFraction("<sheet.pdf>", 3));
'
```

Then `Read` the PNG it produced.

`inkFraction` is a cheap pre-check. A freshly generated page with only the
printed question sits around **0.002–0.008**; anything at or below that means
nothing was written. Use it to skip a page without spending a model call on it.

### 3. Grade, with confidence stated

For each attempted page, judge the handwritten work against the manifest's
`expected`. Report:

- **verdict** — correct / partially correct / incorrect
- **confidence** — `high` / `medium` / `low`, about *how well you could read it*,
  separate from whether it's right
- **what you read** — a one-line paraphrase of the answer you saw

**Confidence governs whether anything is logged.** Reading handwritten
mathematics is materially harder than reading print, and a confidently wrong
grade is worse than no grade: it writes a false result into an append-only log
and corrupts both mastery and the calibration baseline.

| Situation | Do this |
|---|---|
| High confidence | Grade it and log it |
| Medium or low confidence | Show what you read and **ask before logging** |
| Ink present but illegible | Report unreadable; log nothing; suggest a photo |
| No ink (`inkFraction` at baseline) | Report **not attempted**; log nothing |

Never grade an unreadable page as incorrect. "I couldn't read it" and "you got
it wrong" are different facts with different remedies.

### 4. Log

One `quiz` event per topic, aggregating that topic's pages. Partial credit is
fractional — `correct: 3.5` flows through the mastery scheduler cleanly:

```bash
node lib/log-event.js '[
  {"type":"quiz","class":"15-122","topic":"loop-invariants","asked":2,"correct":1.5,"missed":["uses invariant at loop top instead of exit"]}
]'
```

Skipped, unreadable, and unattempted pages are **excluded from `asked`** — they
are not evidence either way, and counting them as wrong would fabricate a
weakness.

If the whole sheet was graded in one pass, also log it as one practice sitting so
it appears in `studyos calibrate`:

```bash
node lib/log-event.js '[
  {"type":"exam","class":"15-122","exam":"worksheets/2026-07-29-15-122-2-topics","kind":"practice","topic":"loop-invariants","asked":2,"correct":1.5}
]'
```

Then run `./bin/studyos rebuild <class>`.

### 5. Report

Per page: verdict, what you read, and the specific misconception if wrong —
"you used the invariant at the loop top where the exit condition is what's
needed", not "review invariants". Close with the score, what was skipped or
unreadable, and one concrete next step.

## Rules

- `--pages N` grades only that page. Live mode uses this, one question at a time.
- Grade against the manifest's `expected`, but accept a correct answer that
  arrives by an unexpected route — say so and count it right.
- Never re-grade a page that already has a logged event for this sheet unless
  explicitly asked; the log is append-only and double-counting inflates mastery.
