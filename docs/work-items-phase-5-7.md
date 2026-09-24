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

## Validating against real traces

Everything above was verified against seeded fixtures, which I wrote myself and
which therefore only contained the patterns I already had in mind. Running the
same code over a real 19MB capture, 41 projects and 892 traces, found four
faults that the fixture suite rated 100% clean.

### The extractor read source line ranges as tickets

Three of the ten detected work items were titled `L12-38`, `L30-44` and
`L52-71`. They came from a code review that cited line ranges:

```
`L52-71: delete: retry wrapper around an idempotent local call.`
```

The key pattern `[A-Z][A-Z0-9]{1,9}-\d+` accepts `L52` as a project prefix. A
denylist cannot fix this because the digits are unbounded, so the guard is a
shape rule: a single letter followed by digits is never a project key. Keys with
two or more leading letters, including `OM2-14`, are unaffected.

A 30% false-positive rate, on a fixture suite reporting 100% precision.

### Suggestions existed but were unreachable

The backfill reported 84 suggestions. The inbox showed none.

The inbox took the 100 newest unlinked prompts and then looked for suggestions
among them. With 536 unlinked prompts in one project, every suggested prompt was
older than that window. The feature was invisible on any project large enough to
need it. Traces with a pending suggestion now sort first, with date ordering
inside each group.

### Overlap coefficient handed short prompts a perfect score

`continue on stage 02` scored 1.00 against an unrelated work item. Its only
surviving tokens were "continue" and "stage", and overlap coefficient divides by
the smaller set, so two matched words out of two is a perfect match.

Two changes. Process and continuation words joined `BROAD_TERMS`, so that prompt
now tokenizes to nothing at all. And the score is scaled by
`min(1, shared / 3)`, so two shared words can no longer express certainty. Three
or more scores at face value.

### URL scaffolding created false matches

`https`, `github` and `com` survived tokenizing, so any two prompts quoting a
GitHub link shared three tokens. That is why two unrelated items tied at exactly
0.50 on the same prompt. Those tokens are now broad terms. Path segments such as
`backnotprop` stay, since they are genuinely distinctive.

### Results

Suggestions fell from 84 to 76, and the survivors are defensible. Work items
fell from 10 to 7, all legitimate. The four real prompts are now fixtures in the
evaluation set, which grew from 24 to 28.

### What the quality panel says about real coverage

On real data: 19% of prompts got a candidate, and 93% remain unlinked.

That is the honest number, and it is the one the design asked to watch. Ticket
keys only appear in prompts when someone types them, and mostly nobody does.
The feature works correctly and covers a minority of real work. Raising that
number is a product question, not a bug, and the panel is what makes the
question answerable instead of guessable.

## Closing the last design gaps

A section-by-section audit against the design doc found four things the
implementation had skipped, plus three places where the shipped code differs
from the design on purpose.

### What was missing, and is now built

**Work totals on the item detail.** The design asked for tool, agent, MCP,
token and credit totals. Only tokens and credits existed. The `traces` table
already carried `tool_calls`, `skill_count`, `agent_count` and `mcp_count`, so
the aggregate select now sums all four plus a distinct session count, and the
detail panel shows them.

**First seen and status history.** `work_item_status_history` was written on
every status change and cleaned up on delete, but only analytics ever read it,
and only for cycle time. The detail view now lists every transition with its
timestamp, and shows the earliest linked prompt as First seen.

**The `relationship` column was dead.** It existed, defaulted to `'work'`,
which is not one of the design's three values, and nothing read or wrote it.
Linking now derives it: the first prompt on an item is `primary`, a link made
below the auto-link threshold is `reference`, everything else is `supporting`.
The default is corrected to `supporting`.

Worth noting that the type change had a trap. `relationship` first went on
`WorkItemTraceSummary`, which the inbox and dismissed-prompt types both extend.
Those describe prompts linked to nothing, so the field was meaningless there and
the compiler said so. Linked prompts now have their own `LinkedTraceSummary`.

**The seventh success measure.** Six of seven were implemented. The missing one
is time from first prompt to recovered work-item context. Grouping is what
recovers the context, so it is measured as the gap between an item's earliest
prompt and the moment the item existed. Auto-detection makes it near zero. A
backfill run weeks later makes it large, which is the point: it separates
"caught it live" from "reconstructed it after the fact".

### Deliberate deviations

Three places differ from the design and stay that way.

`WorkItemLinkSource` is `detected | manual | similarity | suggested` rather than
the design's `ticket | keyword | similarity | manual | git`. The field records
*how the link was decided*, not which signal fired, and the signal is already
recoverable from the references table. `git` never became a linking signal at
all, only evidence.

`WorkItemSource` is `detected | manual` rather than `prompt | response | git |
manual | combined`. Detection only ever reads prompts, so the finer split would
be four dead values and one real one.

The workspace tabs are Work items, Inbox and Productivity, not the design's
Overview, Work items, Sessions and Traces. Sessions and traces already have
their own pages, and an Overview tab above three tabs was a layer of chrome with
nothing in it.

### What the seventh measure reads on real data

28.4 days, across 7 items. That is not a bug and not a failure. Backfill was
run today over prompts going back to mid-August, so every item's context was
recovered weeks after the work happened. The number is measuring exactly the
gap it was designed to measure. Once the daemon runs with detection live, new
items should land near zero and the average should fall as they accumulate.
That decay is the signal worth watching.
