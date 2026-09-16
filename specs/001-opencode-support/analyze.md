# Specification Analysis Report: OpenCode Host Support

Read-only cross-artifact analysis of spec.md, plan.md, and tasks.md, run in YOLO mode as part of
the Stage 02 pipeline (subsumed into the Stage 03 entry gate rather than a separate interview).

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Coverage Gap | MEDIUM | spec.md FR-012 / tasks.md | FR-012 (independent concurrent sessions) has no task explicitly naming "concurrent sessions"; coverage is implicit in T003's session-id keying | Add a one-line note to T003 or T011 calling out concurrent-session verification, or accept implicit coverage |
| F2 | Coverage Gap | LOW | spec.md FR-008 / tasks.md | FR-008 ("no regression when OpenCode absent") has no dedicated implementation task; it's an emergent property of additive-only changes, verified only by T022 | Acceptable — T022's regression check is the correct verification point; no new task needed |
| F3 | Ambiguity | LOW | spec.md SC-001 / plan.md | "within a few seconds" / "a few seconds" is not a hard numeric bound (same wording reused consistently across spec and plan, so no drift — just inherently soft) | Optional: tighten to a specific upper bound (e.g., "<=10s") if stricter QA is desired; not blocking |
| F4 | Underspecification | LOW | research.md R2 / tasks.md T007 | Exact `message.updated` payload field names for token usage are explicitly deferred to implementation time (documented as "Outstanding items", not a spec gap) | No action needed — already flagged as a known implementation-time confirmation, with a defined fallback (token-counts-only) if fields are absent |
| F5 | Inconsistency | LOW | plan.md Project Structure | `assets/opencode-plugin/copilot-tracer.js` is a new top-level `assets/` dir not previously present in the repo; plan.md documents it but constitution's "Additional Constraints" doesn't mention plugin-template assets as a category | Non-issue — constitution governs runtime behavior/dependencies, not asset file organization; no MUST is implicated |

## Coverage Summary Table

| Requirement Key | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-001 (ingest lifecycle) | Yes | T003, T007 | |
| FR-002 (project auto-detect) | Yes | T006 | |
| FR-003 (tool classification) | Yes | T002 | |
| FR-004 (credit/cost calc) | Yes | T018, T019 | |
| FR-005 (real-time dashboard) | Yes | T005 | |
| FR-006 (setup detect/install/skip/fail) | Yes | T013, T014, T015 | |
| FR-007 (additive install) | Yes | T012, T014 | |
| FR-008 (no regression when absent) | Indirect | T022 | See F2 |
| FR-009 (tolerate malformed/duplicate) | Yes | T003, T004, T007, T008 | |
| FR-010 (fallback project) | Yes | T006 | |
| FR-011 (stale-turn timeout) | Yes | T004 | |
| FR-012 (concurrent sessions) | Indirect | T003 | See F1 |
| SC-001 (dashboard latency) | Yes | T005, T011 | |
| SC-002 (100% tool classification) | Yes | T002, T011 | |
| SC-003 (cost accuracy) | Yes | T018, T019, T021 | |
| SC-004 (zero regression) | Yes | T022 | |
| SC-005 (one-command setup) | Yes | T013–T017 | |

**Constitution Alignment Issues:** None. All five principles map cleanly to plan.md's
Constitution Check table (all PASS); no MUST statement is contradicted by any FR or task.

**Unmapped Tasks:** None — T001 (baseline typecheck), T010/T016/T020/T024 (typecheck gates),
T023 (docs) are cross-cutting/process tasks, not requirement-mapped by design.

**Metrics:**
- Total Requirements (FR + SC): 17 (12 FR + 5 SC)
- Total Tasks: 24
- Coverage % (requirements with ≥1 task, including indirect): 100% (15 direct + 2 indirect)
- Ambiguity Count: 1 (F3, LOW)
- Duplication Count: 0
- Critical Issues Count: 0

## Next Actions

No CRITICAL or HIGH issues found. All findings are MEDIUM/LOW and non-blocking. Proceeding to
Stage 03 (implementation) is recommended as-is; F1 and F3 are optional polish items that can be
addressed during implementation without re-running planning.
