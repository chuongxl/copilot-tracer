# Work item grouping: measured baseline

Run the evaluator yourself:

```bash
npx tsc && node scripts/evaluate-work-item-grouping.mjs          # table
npx tsc && node scripts/evaluate-work-item-grouping.mjs --json   # machine readable
```

The script exits non-zero if precision falls below the threshold or if any
sensitive-looking value is mistaken for a ticket reference.

## Baseline, extractor 1.0.0

24 fixtures across eight categories.

| Metric | Value |
|---|---|
| Precision | 100% |
| Recall | 100% |
| F1 | 100% |
| Auto-link acceptance | 100% of prompts that carry a reference |
| Correction rate | 0% |
| Unlinked rate | 50% |
| Sensitive leaks | 0 |
| Precision threshold | 95% |

Unlinked at 50% is not a failure. Half the fixtures deliberately carry no
ticket at all, which is what the inbox exists for.

| Category | Fixtures | Exactly right |
|---|---|---|
| Exact Jira keys | 3 | 3 |
| Lower case (known limit) | 1 | 1 |
| GitHub issue and PR URLs | 3 | 3 |
| Multiple tickets in one prompt | 2 | 2 |
| Similar wording, different tasks | 3 | 3 |
| Follow-ups with no key | 3 | 3 |
| Unrelated prompts sharing nouns | 3 | 3 |
| Sensitive-looking values | 4 | 4 |

## What the first run caught

Writing the fixtures paid for itself immediately. Two real defects showed up on
the first run, both of which would have reached users.

`AKIA-1234` was being read as a Jira ticket. An AWS access key ID starts with
`AKIA`, so a prompt that accidentally pasted a credential would have created a
work item titled after the key and stored it in the database. Fixed by adding
credential prefixes (`AKIA`, `ASIA`, `GHP`, `XOXB`, `SK`, `TOKEN`, `SECRET` and
friends) to the extractor's denylist.

A lower-case `abc-123` was not detected. This one is intentional and stays that
way. Matching lower case would also match `step-1`, `node-18`, `top-10` and
every other hyphenated word-number pair in ordinary prose. A false work item is
worse than a missed one: it pollutes the workspace and a person has to clean it
up. A missed one just waits in the inbox where it is easy to attach by hand.

## Where automatic grouping is safe

Safe to link automatically:

- Upper-case Jira keys, `ABC-123`
- GitHub issue and PR URLs, both resolved to `owner/repo#number`
- Several references in one prompt, each linked separately

Never linked automatically, by design:

- Follow-up prompts with no reference. They land in the inbox.
- Prompts that only share vocabulary with an existing item. Wording is not
  evidence. Grouping "add a project filter to the dashboard" with "add a project
  filter to the reports page" would be wrong, and the fixtures prove the current
  extractor keeps them apart.

## Decision on similarity scoring and AI enrichment

Not implemented, and not planned on this evidence.

Task 9 of the plan says to add enrichment only if the baseline shows a
measurable gap that the technique can close without weakening the privacy
guarantee. There is no such gap. Deterministic extraction scores 100% precision
and 100% recall on every fixture that carries a reference, so a similarity model
has nothing left to fix there.

The remaining 50% are prompts with no ticket at all. Similarity could guess at
those, but guessing is exactly what the inbox is designed to avoid, and a wrong
guess costs a person more time than attaching a prompt by hand. Sending prompt
text to a model would also break the rule that nothing leaves the machine.

Revisit this if real usage shows a high inbox backlog that people find tedious
to clear. Add fixtures from that real usage first, then measure again. Any
future technique must keep precision at or above 95% and must keep sensitive
leaks at zero.
