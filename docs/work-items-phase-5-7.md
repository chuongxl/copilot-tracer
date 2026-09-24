# Phases 5 and 7: suggestions and productivity analytics

The design listed seven delivery phases. Six and the first four shipped earlier.
This note covers the last two: similarity suggestions in the inbox (phase 5) and
productivity analytics built on confirmed work items (phase 7).

## Phase 5: suggestions

### A suggestion is not a link

The tempting shortcut is to reuse `work_item_traces` with a
`link_source = 'similarity'` row and a pending flag. I gave suggestions their
own table instead.

The reason is measurement. The design asks for "percentage of suggested links
accepted" as a health signal. If a guess and a confirmed link live in the same
table, that number is unrecoverable after the fact. Keeping
`work_item_suggestions` separate means an auto-link the user never questioned
and a guess the user approved stay distinguishable forever. Accepting a
suggestion writes a real link and stamps the suggestion `accepted`; rejecting
stamps it `rejected` and writes nothing else.

`UNIQUE(trace_id, work_item_id)` stops re-ingestion from stacking duplicates.

### They ride inside the inbox

Suggestions do not get their own tab. The inbox already answers "what should
happen to this prompt?", and a second list answering the same question with
different buttons would just split attention. `getUncategorizedTraces` returns
`SuggestedTrace[]`, and rows with a candidate render an extra strip with Accept
and No.

### Scoring runs on distinctive words only

Naive token overlap fails immediately on this data. Every prompt in a web repo
says "dashboard" or "api" or "fix". Those words carry no signal about *which*
item a prompt belongs to, but they dominate any overlap score.

So `distinctiveTokens` strips two lists. `STOP_WORDS` is the usual grammar
("the", "with", "should"). `BROAD_TERMS` is the domain noise: dashboard, api,
test, bug, feature, page, code, file, update, fix. What survives is the words
that actually name a thing.

The design's own worked example demanded this. "Fix the dashboard API" versus
"update the dashboard API code" must stay unlinked. After stripping, both sides
are empty and the score is exactly 0. Without stripping it would have been a
near-perfect match.

### Overlap coefficient, not Jaccard

Jaccard divides by the union, which punishes a three-word prompt for being
compared against a forty-word work item summary even when every one of those
three words appears in it. Overlap coefficient divides by the smaller set, so
full containment scores 1.0 regardless of length difference. Prompts are short
and summaries are long, so this matters constantly.

### Thresholds

| Constant | Value | Why |
| --- | --- | --- |
| `MIN_TOKEN_LENGTH` | 3 | Two-letter fragments match everything |
| `MIN_SHARED_TOKENS` | 2 | One shared rare word is a coincidence |
| `SIMILARITY_SUGGEST_MIN` | 0.34 | Roughly one in three distinctive words shared |

0.34 came from running the fixture set and finding the point where the known
true pairs cleared the bar and the known false pairs did not. It is a tuned
number, not a principled one, and the grouping-quality panel exists so it can be
re-tuned against real acceptance rates rather than my guesses.

### Ambiguity is surfaced, not resolved

If more than one open item clears the threshold, every candidate is marked
`ambiguous`. The UI switches from a blue "Suggested match:" to an amber
"Several items could match. Pick one:". Picking one auto-rejects the others for
that trace.

Silently taking the top score would be worse than asking. A wrong link inflates
an item's token totals and costs the user a merge or split to undo, which the
corrections counter then records as a failure of the system.

### Suggestions never fire when there is real evidence

`persistWorkItemEvidence` only reaches the suggestion path when extraction found
no ticket key and no strong signal. A deterministic match always wins.

## Phase 7: analytics

### Cycle time comes from a status history table

`updated_at` is worthless for this. Fixing a typo in a title rewrites it. So
every status transition writes a row to `work_item_status_history`, and cycle
time is the gap between the first row and the row that moved the item to a
closed status.

A migration gives items that predate the table one synthetic history row so
they are not silently excluded.

### Negative durations return null

`msBetween` returns `null` when the end precedes the start. Backfilled data and
clock skew can produce that, and "-4m" on a dashboard destroys trust in every
other number on the page. There is a test for it.

### Nulls are not zeros

Every average in the report can be null and renders as a dash. "No completed
items yet" and "completed in zero time" are different facts and must look
different.

### Two fields that are not there

`models` was in the first draft of `WorkItemAnalytics`, but there is no model
column on `traces` or `sessions`, so it would have been a field that always read
empty. Dropped rather than faked.

`topByCredits` tiebreaks on tokens because OTLP-sourced traces record
`ai_credits = 0`. Without the tiebreak the table would sort arbitrarily for most
real users.

### Corrections are events, not inferred state

Merges, splits, and unlinks each write a row to `work_item_corrections`. The
current shape of the data cannot tell you that two items were merged last week.
An event table can.

## Two things the browser caught that tests did not

**`fmtDuration` collided.** `web/index.html` is a single script. I added a
`fmtDuration` for work-item spans around line 839, unaware that a trace-level
`fmtDuration` at line 1534 formats milliseconds as `2192.0s`. The later
definition won and every cycle time rendered in seconds. Renamed mine to
`fmtSpan`, and the e2e script now asserts each name is defined exactly once and
that the analytics renderers never call `fmtDuration`.

**Tables overflowed their cards.** Five-column tables in a three-across grid
clipped the rightmost column. `.an-grid` now uses `minmax(520px, 1fr)` so the
tables get two columns of real width, and `.an-card` has `overflow-x: auto` as
a backstop.

Neither failure would have tripped any assertion I would have thought to write.

## One thing fixed along the way

The dashboard's headline tile counted `status = 'active'` only. Auto-detected
items start as `detected`, so the tile read 0 while four items waited to be
confirmed. `workItemTotals` now also returns `open` (everything not completed or
archived) and the tile reads "Open Work Items", matching the workspace.

## Still deferred

- No model call anywhere. Everything here is string comparison.
- Suggestions only consider open items in the same project. Closed items are
  never suggested.
- `getProjectWorkItemSummary` still runs about four queries per project card. It
  should fold into the grouped query if anyone accumulates many projects.
- No time-window filter on analytics. Everything is all-time.
