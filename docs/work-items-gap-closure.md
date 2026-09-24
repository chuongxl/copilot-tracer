# Work items: closing the gaps against the design

The nine tasks in `docs/superpowers/plans/2026-09-24-work-items-productivity.md`
all shipped, but an audit against `docs/work-items-productivity-design.md` found
six places where the code did less than the spec. This round closes all six.

## What changed

### Dashboard shows work-item data

`getDashboard` used to return sessions, tokens, credits and last-active only, so
nothing on the landing page hinted the feature existed. Each project card now
carries a `workItems` rollup: counts by status, distinct ticket references,
unlinked prompt count, and the three most recently updated titles. Two totals
sit alongside the existing four: active work items and unlinked prompts.

The rollup runs one small query per card, matching the existing `lastSession`
pattern. At a page size of 12 that is cheap. If project counts grow into the
hundreds per page, fold these into the main grouped query.

### The inbox can be cleared

Before, the only way out of the inbox was linking a prompt to a work item. A
question like "why is the staging deploy taking eleven minutes?" would sit there
forever, and the unlinked-prompt count the design uses as a success measure
would drift into noise.

`work_item_dismissed_traces` records a dismissal with a reason, either `ignored`
or `unrelated`. Dismissed prompts leave the inbox and appear in a Dismissed list
with a Restore button. The trace itself is never touched, and linking a
dismissed prompt to a work item clears the dismissal automatically.

### Merge and split

`POST /api/work-items/:id/merge` folds other items into a target, moving trace
links, ticket references and acceptance criteria, then deletes the sources. It
refuses a cross-project merge and refuses to merge an item into itself.

`POST /api/work-items/:id/split` moves selected prompts into a new item. It
requires at least one prompt to stay behind, because moving everything is a
rename and belongs in PATCH.

Raw traces survive both operations, so a bad merge costs one split to undo.

In the UI, the detail view grew a checkbox per linked prompt plus "Merge in…"
and "Split out…" buttons.

### Full status vocabulary

`active | done | archived` became the spec's
`detected | active | paused | blocked | completed | archived`. Existing rows
migrate from `done` to `completed` on startup.

The interesting part is `detected`. Auto-created items now start there rather
than jumping straight to `active`, which gives the design's Confirm action
something to do: it promotes a detected item to active. The status filter now
defaults to All so newly detected items are not hidden.

### Bare `#42` references

The design lists `#42` alongside `owner/repo#42`. It was never implemented,
probably because a bare number is ambiguous. It now resolves, but at confidence
0.6, under the 0.8 auto-link threshold, so it shows as evidence without
grouping anything on its own. A CSS colour like `#42a5f5` is rejected by the
digit-only match, and `color: #123` by a preceding-context check.

### A `performance` kind

The design listed performance signals (`slow`, `latency`, `optimize`) but the
controlled vocabulary had no `performance` kind, so those prompts fell to
`unknown`. The spec contradicted itself; the kind now exists and sits between
`bug` and `investigation` in the tie-break order. A prompt phrased as a fix
still classifies as a bug, which is the right call.

## Still open, and deliberately so

- **Suggest tier.** The design's middle confidence band stays empty for detected
  references. `docs/work-items-evaluation.md` measured no grouping gap that
  similarity matching would close. Bare issue refs are the first thing to land
  in this band if it is ever built.
- **Productivity analytics.** Delivery phase 7, never in the nine tasks.
- **Schema fields from the spec that are still missing.** Ticket references
  carry no `source_trace_id` or `confidence`, trace links have no
  `relationship`, and the `source` enums stay narrower than the spec's five
  values. There is no status history table. None of these block a user today,
  but `source_trace_id` is the one worth adding next, since it answers "which
  prompt introduced this ticket?" and the table is still young.
- **Extraction errors** are logged, not persisted.

## Verification

- `node scripts/test-work-item-extraction.mjs` — 64 assertions
- `node scripts/verify-work-items.mjs` — 42 assertions
- `node scripts/evaluate-work-item-grouping.mjs` — 24 fixtures, precision and
  recall still 100%, zero sensitive leaks
- `npx tsc --noEmit`
- Browser run against `scripts/demo-work-items.mjs`, screenshots 11 to 18 in
  `docs/screenshot/work-items/`

The browser run earned its keep again. It caught every work item card rendering
"DETECTED DETECTED", because the status badge and the source badge both spelled
the same word. The source badge now reads "auto".
