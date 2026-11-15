# How REGISTER lessons teach

REGISTER teaches low-level computing through music. A learner should never meet a word they were not given, never learn a computer idea without hearing what it does, and always know whether they got it.

This file is the standard every lesson is held to. Parts of it are checked by tests, so a lesson that breaks those rules fails the build.

## Who the lessons are for

Someone curious who has never programmed and never studied music. They can count, click and type. Nothing else is assumed.

## The rules

1. **One big idea per lesson.** A lesson teaches one computer idea. Everything else on the page supports it.
2. **Define every term the first time it appears.** One plain sentence, right where the word is first used. Mark it with `<dfn data-term="...">`.
3. **Link out from every term.** Each definition ends with a "more" link for anyone who wants depth.
4. **Build only on earlier lessons.** A lesson may use any term from an earlier lesson, and none from a later one.
5. **Music before.** The learner hears the musical idea first, in plain words, before any computer idea.
6. **Music after.** Once the computer idea is learned, return to the music and explain it again with the new idea. The two should turn out to be the same idea.
7. **Hands on early.** Within the first few minutes the learner changes something and hears the result.
8. **Check yourself.** Goals the page verifies on its own, including one transfer task: a problem the examples did not show step by step.
9. **Recap.** Every new term appears in a "What you just learned" table at the end.
10. **Plain language.** Short sentences. No jargon that is not defined.

Headings, the objectives box and links to other lessons may name a term before its definition, since they preview what is coming. Mark the box and the links with `data-terms-ok`. Body text may not.

## The lesson template

Every lesson follows the same shape, so a learner always knows where they are.

| Part | What it does |
|---|---|
| Objectives | What you will be able to do, in "you can" terms, and how long it takes |
| Hear it | The musical idea, heard and named in plain words |
| The computer idea | One idea, built on the last lesson, every term defined where it first appears |
| Try it | Change memory, hear the result, reach a goal |
| Hear it again | The musical idea explained with the new computer idea |
| Check yourself | Goals the page checks, a transfer task, and questions with hidden answers |
| What you just learned | Every new term, music and computer, in one table |

## Rubric for lessons

Score each criterion 0 (missing), 1 (partly) or 2 (meets). A finished lesson scores 24. Rows marked *test* are enforced by `tests/unit/terms.test.js` or the browser tests.

| # | Criterion | 2 means |
|---|---|---|
| 1 | Objectives | States what the learner can do afterward, and how long it takes |
| 2 | One big idea | One computer idea; everything else supports it |
| 3 | Builds on earlier lessons | Uses no term or idea from a later lesson (*test*) |
| 4 | Terms defined at first use | Every term has a one-sentence definition where it first appears (*test*) |
| 5 | Terms link out | Every definition has a "more" link (*test*) |
| 6 | Music before | The musical idea is heard and named before the computer idea |
| 7 | Music after | The musical idea is explained again with the new computer idea |
| 8 | Hands on early | The learner changes memory and hears it within the first few minutes |
| 9 | Check yourself | Self-checking goals, including one transfer task, plus questions with hidden answers |
| 10 | Recap | Every new term is in the recap table (*test*) |
| 11 | Plain language | Short sentences, nothing undefined |
| 12 | Works for everyone | Keyboard, screen reader labels, phone width (*test* for phone width) |

## Rubric for learners

Each lesson ends with "You've got it when" criteria. A learner has the lesson when:

- every goal on the page shows **Done**, including the transfer task, and
- they can answer each "Check yourself" question out loud before opening its answer.

If a goal will not tick, the hint under it is the next step. If an answer surprises them, the section it points back to is the one to reread.

## The glossary

`glossary.json` lists every term: the lesson that introduces it, whether it is a music or computer word, its one-sentence definition, and its "more" link. The term test reads it to check that:

- each term has a `<dfn data-term>` in its lesson,
- the term does not appear in that lesson's body text before its `<dfn>`,
- the term does not appear in any earlier lesson,
- the paragraph with the `<dfn>` links to the term's "more" page,
- the recap table lists it, and
- every `<dfn>` in a lesson is in the glossary.

Only lessons rewritten to this standard have glossary entries. Add a lesson's terms when you rewrite it.

Terms match in any case. A term marked `"case": true` matches its exact case only. That is how lesson 6 teaches the word *register* while every page carries the name REGISTER.

## Where the lessons stand

Scored against the rubric above. The first three columns are the original three lessons, before this standard. The rest are the lessons now: the old lesson 3 became lessons 4 and 5, and lessons 3, 6, 7 and 8 are new.

| # | Criterion | Old 1 | Old 2 | Old 3 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Objectives | 0 | 0 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 2 | One big idea | 2 | 0 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 3 | Builds on earlier lessons | 2 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 4 | Terms defined at first use | 1 | 1 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 5 | Terms link out | 0 | 0 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 6 | Music before | 0 | 0 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 7 | Music after | 1 | 0 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 8 | Hands on early | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 9 | Check yourself | 1 | 1 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 10 | Recap | 1 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 11 | Plain language | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 12 | Works for everyone | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| | **Total** | **14** | **9** | **13** | **24** | **24** | **24** | **24** | **24** | **24** | **24** | **24** |

Every lesson is now 24 by this rubric. The rubric checks the rules, not whether learners actually learn, so the next real test is watching someone new go through them.

One known soft spot in lessons 1 to 5: a goal checks memory, not how the learner got there, so a transfer task meant to be worked out on paper can still be solved by clicking boxes. The hidden-answer questions are what catch that. Lessons 6 to 8 close the gap for their own goals: they check what the learner's program stored, so clicking boxes cannot meet them.

## The lesson map

One big idea per lesson, each paired with the music it explains.

| # | Music idea | Computer idea | Status |
|---|---|---|---|
| 1 | Beat, bar, sixteenth notes | Memory, addresses, POKE | Rewritten |
| 2 | Rhythm as hits and rests, the tresillo | Bits, binary, hex as one digit per beat | Rewritten |
| 3 | Pitch, semitones, octaves, transposing | Note numbers, encoding, arithmetic | Written |
| 4 | Timbre and the envelope (ADSR) | Structs, fields, base addresses, offsets | Written |
| 5 | Doubling and patches | Arrays, indexes, pointers, compilers | Written |
| 6 | Intervals and the major scale | Processors, instructions, registers, assembly language | Written |
| 7 | Repeat signs and Euclidean rhythms | Labels, jumps, counters, branches | Written |
| 8 | Mixers, mute and solo | Flags, bitmasks, AND and OR | Written. Needed a new chip byte, VOICE_MUTE at `$10AA` |
