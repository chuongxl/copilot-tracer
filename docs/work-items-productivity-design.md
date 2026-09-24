# Work Items and Engineering Productivity Design

## Goal

Turn Copilot Tracer from a project and trace viewer into a trustworthy engineering work journal. The system should help an engineer recover task context, detect ticket references, summarize requirements, and group related prompts without silently inventing project state.

## Product judgment

The first release should not attempt fully automatic task management. Ticket identity is often deterministic, but intent and completion are ambiguous. The product should automatically extract strong evidence, suggest uncertain relationships, and give the engineer explicit controls to confirm, merge, split, unlink, or archive work.

## Current system

The existing data flow is:

```text
Copilot CLI / VS Code / Claude telemetry
        |
        v
src/otlpReceiver.ts
        |
        v
Project -> Session -> TraceEntry
        |
        +--> src/db.ts aggregation
        |
        +--> web/index.html dashboard and live tracer
```

`TraceEntry` already stores the raw prompt, response, token usage, credits, tools, agents, MCP calls, duration, status, and error. `Project` and `Session` already provide the ownership and timeline boundaries. The missing domain object is a durable work item between a project and its traces.

## Domain model

Add a `WorkItem` owned by a project and a many-to-many link between work items and traces.

```text
Project
  └── WorkItem
        ├── WorkItemTrace -> TraceEntry
        ├── ticket references
        ├── requirement summary
        ├── acceptance criteria
        └── status history
```

### Work item fields

| Field | Shape | Meaning |
|---|---|---|
| `id` | text primary key | Stable internal ID |
| `project_id` | text, required | Owning project |
| `title` | text, required | Editable human-readable title |
| `kind` | enum text | `feature`, `bug`, `task`, `refactor`, `investigation`, `performance`, `documentation`, `operations`, `unknown` |
| `status` | enum text | `detected`, `active`, `paused`, `blocked`, `completed`, `archived` |
| `summary` | text nullable | Extracted or edited objective |
| `acceptance_criteria` | JSON text nullable | Extracted or edited criteria |
| `confidence` | real nullable | 0.0 to 1.0 extraction confidence |
| `source` | enum text | `prompt`, `response`, `git`, `manual`, `combined` |
| `created_at` | ISO text | Creation time |
| `updated_at` | ISO text | Last change time |

### Work item trace link fields

| Field | Shape | Meaning |
|---|---|---|
| `work_item_id` | text | Linked work item |
| `trace_id` | text | Linked trace |
| `relationship` | enum text | `primary`, `supporting`, or `reference` |
| `confidence` | real | Confidence in the link |
| `source` | enum text | `ticket`, `keyword`, `similarity`, `manual`, or `git` |
| `created_at` | ISO text | Link creation time |

One trace may discuss several work items. One work item may span many prompts and sessions. The join table is therefore required.

### Ticket reference fields

Store extracted references separately so one work item can contain multiple tickets.

| Field | Meaning |
|---|---|
| `reference_type` | `jira`, `github_issue`, `github_pr`, `azure_work_item`, or `url` |
| `reference_key` | Example `ABC-123` or `owner/repo#42` |
| `url` | Canonical URL when present |
| `source_trace_id` | Trace that supplied the reference |
| `confidence` | Extraction confidence |

## Extraction pipeline

Extraction must be asynchronous after the trace is persisted. Telemetry ingestion must never wait on a model or external ticket service.

```text
Trace persisted
    |
    v
Deterministic parser
    |-- ticket keys
    |-- issue and PR URLs
    |-- branch and explicit task language
    v
Candidate matcher
    |-- exact ticket match
    |-- active work items in project
    |-- recent session and file context
    v
Optional enrichment
    |-- title
    |-- work kind
    |-- requirement summary
    |-- acceptance criteria
    v
Confidence policy
    |-- auto-link strong evidence
    |-- suggest medium evidence
    |-- keep weak evidence unlinked
    v
Engineer confirmation
```

### Deterministic extraction

Detect these without an LLM:

- Jira keys such as `ABC-123`.
- GitHub issue references such as `#42`, `owner/repo#42`, and issue URLs.
- Pull request URLs.
- Azure DevOps work-item URLs.
- Explicit phrases such as `ticket`, `issue`, `bug`, `PR`, `pull request`, and `story`.

The parser should return structured candidates with the source span, normalized value, type, and confidence. It must not claim that a ticket exists remotely unless a configured integration verifies it.

### Work kind classification

Begin with a deterministic classifier. Use a controlled vocabulary and return `unknown` when evidence is weak.

- Feature signals: `add`, `support`, `introduce`, `allow`, `implement`.
- Bug signals: `fix`, `broken`, `does not work`, `regression`, `error`.
- Refactor signals: `refactor`, `rename`, `extract`, `dedupe`, `cleanup`.
- Performance signals: `slow`, `latency`, `optimize`, `performance`.
- Investigation signals: `investigate`, `why`, `understand`, `trace`.
- Documentation signals: `document`, `readme`, `docs`, `guide`.

### Summary enrichment

AI-generated summaries are advisory and editable. Store the original prompt, generated summary, model name, extraction timestamp, and confidence. Never overwrite raw traces or silently replace an engineer-authored title.

## User experience

### Dashboard

Keep the current project cards and add:

- Active work item count.
- Recently updated work item titles.
- Unlinked prompt count.
- Ticket reference count.
- Last activity.

Aggregate token and credit totals remain global and separate from filtered work-item counts.

### Project workspace

Add a project-scoped workspace with these tabs:

1. **Overview**. Active work, recent activity, and high-level usage.
2. **Work items**. Grouped features, bugs, tasks, investigations, and tickets.
3. **Sessions**. Existing session summaries.
4. **Traces**. Existing detailed trace view.

### Work item detail

Show and edit:

- Title, kind, status, and summary.
- Acceptance criteria.
- Ticket and PR links.
- Linked prompts, sessions, and traces.
- Tool, agent, MCP, token, and credit totals.
- First seen, last active, and status history.
- Extraction evidence and confidence.

Actions must include **confirm**, **merge**, **split**, **unlink**, **archive**, and **edit**.

### Uncategorized inbox

Prompts that cannot be confidently grouped belong in an inbox. The engineer can create a work item, attach the prompt to an existing item, ignore it, or mark it unrelated.

## Confidence policy

| Evidence | Behavior |
|---|---|
| Exact ticket key or URL already attached to an active item | Auto-link |
| Explicit “continue ABC-123” or matching branch/PR | Auto-link |
| Strong similarity to one active item in the same project | Suggest |
| Shared broad words such as “dashboard” or “API” | Leave unlinked |
| Multiple plausible active items | Ask for confirmation |

Completion must require strong evidence such as a successful verification command, a merged PR, or manual confirmation. A positive assistant sentence alone is not enough.

## Privacy and reliability

- Keep raw prompts intact and store generated metadata separately.
- Redact credentials and likely secrets before optional model enrichment.
- Make enrichment opt-in per project.
- Prefer a local model when available.
- Persist extraction status and errors.
- Make enrichment idempotent by trace ID and extractor version.
- Allow generated metadata to be deleted without deleting raw traces.
- Do not block `/v1/traces`, `/v1/logs`, or hook ingestion on enrichment.

## Delivery phases

1. Deterministic ticket and URL extraction.
2. Work-item schema, APIs, and manual grouping.
3. Dashboard and project workspace.
4. Editable summaries and deterministic work-kind classification.
5. Similarity suggestions and uncategorized inbox.
6. Git and PR evidence for progress and completion.
7. Productivity analytics based on confirmed work items.

Each phase must ship a useful, testable product without requiring the next phase.

## Success measures

Measure before adding automation:

- Percentage of traces with at least one detected ticket or work-item candidate.
- Percentage of auto-links accepted without correction.
- Percentage of suggested links accepted.
- Unlinked prompt rate.
- Merge and split correction rate.
- Time from first prompt to recovered work-item context.
- Percentage of completed items with verifiable completion evidence.

The first milestone is not “AI grouped everything”. It is “engineers can find and correct their work context faster than from raw traces”.
