---
description: Generate a handwriting worksheet and drop it in the synced folder for the iPad
argument-hint: <class> [-n 6] [--topic slug]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Generate a worksheet to answer by hand.

Arguments: $ARGUMENTS

Read `.claude/skills/study-os/SKILL.md` for vault conventions first.

## Steps

1. **Resolve the class and pick topics.** Run `./bin/studyos status <class>` and
   take what's due, weakest first — the same selection `/quiz` uses. `--topic`
   pins one. Default 6 questions; `-n` overrides. Cover at most 2–3 topics: a
   worksheet spanning eight topics tests nothing deeply enough to move a mastery
   estimate.

2. **Write the questions** via the `quizmaster` subagent, with one extra
   constraint over a typed quiz: **each question must be answerable by hand on
   one page.** Favour derivations, proofs, traces, and worked examples — the
   things that are genuinely better with a Pencil than a keyboard. Avoid
   anything needing a long code listing.

   For each question the agent returns: `topic`, `question`, and `expected` (what
   a correct answer must contain). `expected` is what makes grading possible
   later without re-deriving intent from an image of your handwriting.

3. **Build the sheet.** Write a small Node script that calls
   `buildManifest`, `writeManifest`, and `writeSheetPdf` from `lib/sheet.js` —
   do not hand-roll the PDF or the paths:

   ```bash
   node --input-type=module -e '
   const {buildManifest,writeManifest,writeSheetPdf}=await import("./lib/sheet.js");
   const m=buildManifest({class:"15-122",questions:[
     {topic:"loop-invariants",question:"...",expected:"..."}
   ]});
   writeManifest(m);
   console.log(JSON.stringify(writeSheetPdf(m)));
   '
   ```

   The library guarantees the two invariants: **one question per page, no cover
   page**, so page N is always question N; and the manifest goes in the vault
   while only the PDF reaches the synced folder.

4. **Report** where it landed and how to answer it:

   ```
   ✓ 6 questions · 2 topics → 2026-07-29-15-122-2-topics.pdf
     iCloud Drive › StudyOS › worksheets

     Open it in Files on the iPad, answer with the Pencil.
     Live grading:  studyos sheet live 15-122
     Grade later:   studyos sheet grade 15-122
   ```

## Rules

- Never invent questions on material with no notes behind it. Say the notes are
  missing and suggest ingesting them — a worksheet on uncovered material measures
  nothing.
- Do not log any event here. Generating a worksheet is not study activity; the
  `quiz` events come from grading it.
- One question per page is not a style preference. Grading addresses pages by
  number, so a cover page or two questions on a page silently mis-grades
  everything after it.
