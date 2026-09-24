# Work items: browser test record

Screenshots in this folder come from a scripted run against a throwaway daemon,
not from anyone's real database. Reproduce them yourself:

```bash
npx tsc
node scripts/demo-work-items.mjs --port 4793
```

The script seeds two projects and prints the workspace URLs:

- `acme/checkout-service`, detected from a repository URL, so it has no checkout
  on this machine. Ten prompts covering two Jira tickets, a GitHub issue, a
  GitHub PR, and three follow-ups with no reference at all.
- `billing-service`, a throwaway git repo created under the temp home with
  three commits, two of which cite `BIL-88`, on a branch named after the ticket.

Ctrl-C stops the daemon and deletes the database.

## What each screenshot shows

| File | Step | Result |
|---|---|---|
| `01-dashboard.png` | Dashboard after ingestion | One project card, 6 sessions, 34,925 tokens |
| `02-workspace-work-items.png` | Clicked the project card | 4 work items, correctly grouped |
| `03-inbox.png` | Inbox tab | Exactly the 3 prompts with no reference |
| `04-detail-before-draft.png` | Opened PAY-412 | Empty criteria, evidence not checked |
| `05-draft-generated.png` | Clicked Generate draft | 4 criteria, "Updated summary, acceptanceCriteria" |
| `06-git-evidence-no-checkout.png` | Checked evidence, URL-only project | Explicit error, not an empty panel |
| `07-git-evidence-matched.png` | Checked evidence, local checkout | Branch flagged "matches ticket", 2 of 3 commits kept |
| `08-completion-declined.png` | Set status done, declined the prompt | Still active |
| `09-completion-confirmed.png` | Repeated, confirmed | Saved as done |
| `10-status-filter-done.png` | Filtered by Done | BIL-88 listed, Active list empty |

## Grouping result

Ten prompts, four work items, three left in the inbox.

| Work item | Kind | Prompts |
|---|---|---|
| PAY-412 | feature | 3 |
| PAY-398 | bug | 2 |
| acme/checkout-service#214 | bug | 1 |
| acme/checkout-service#221 | unknown | 1 |

Kind detection is doing real work here. PAY-412's prompts say "implement" and
"add", PAY-398's say "fix" and "wrong". Neither was labelled by hand.

## Git evidence result

The `billing-service` repo has three commits. Two cite `BIL-88`; the third,
"tidy up the notes file", does not. Only the two matching commits appear, and
the branch `feature/BIL-88-invoice-retries` is flagged. The unrelated commit is
filtered out, which is the whole point: a commit list that shows everything is
just `git log`.

## Completion gate

Setting status to done and saving returned 409 and raised a confirm dialog.
Declining left the item active, verified through the API, not just the screen.
Confirming saved it. The check is server-side, so it holds for anything calling
the API, not only this page.

## Two bugs this run caught

Both were found by looking at the screenshot, not by a failing assertion. Both
are fixed, with regression tests in `scripts/test-work-item-extraction.mjs`.

**The objective was repeated as a criterion.** PAY-412's summary reads
"Implement PAY-412: the checkout page must show the saved card list before the
total", and that same sentence appeared as a fourth acceptance criterion. It
states an obligation ("must"), which is exactly what the criteria collector
looks for. The draft generator now excludes any criterion matching the objective
it already used as the summary.

**Ticket keys leaked into criteria text.** A criterion read "PAY-412 follow-up:
the expired card should still be visible, just not selectable". The ticket key
and the connector mean nothing once the line sits under that ticket's work item.
Criteria now have a leading ticket-key lead-in stripped, so it reads "The
expired card should still be visible, just not selectable".

A side effect worth knowing: a single-sentence prompt whose only requirement is
the objective now produces an empty criteria list. That is deliberate. The
sentence is already the summary, and printing it twice helps nobody.

## Scripted coverage

The browser run complements, and does not replace, the scripted suites:

```bash
node scripts/test-work-item-extraction.mjs     # 51 assertions
node scripts/verify-work-items.mjs             # 29 assertions
node scripts/evaluate-work-item-grouping.mjs   # 24 fixtures
```

Console during the browser run was clean apart from a pre-existing
`favicon.ico` 404 and the deliberate 409 from the completion gate.
