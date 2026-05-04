---
name: claude-plan-to-athanor
description: |
  Convert a Markdown plan (typically from `.claude/plans/*.md` or pasted in
  chat) into an athanor PlanSpec YAML, then run athanor's enrichment with
  the cross-task-aware critic to produce executable task specs under
  `.athanor/tasks/<plan-id>/`. Use when the user has an architectural plan
  in prose form and wants to drive its implementation through athanor.
triggers:
  - "convert this plan to athanor"
  - "enrich this plan with athanor"
  - "use athanor to build this out"
  - "turn this into athanor tasks"
---

# claude-plan-to-athanor

Take a Markdown plan and turn it into a fully-enriched athanor task set
that's ready for `athanor run-plan`. Built on the workflow validated in
the sandcastle-isolation refactor.

## When to use

The user has a Markdown plan (or any prose specification) describing
work that should be implemented as a sequence of focused tasks. They
want to drive implementation through athanor's harness rather than
implement directly.

Skip this skill if:
- The user wants to implement directly without athanor (no harness needed).
- The plan is a single change (use `athanor run` against one task spec).
- The plan is too vague to break into bounded tasks (push back; ask
  for the architectural decisions first).

## Prerequisites

- Working directory is an athanor checkout or a repo with `.athanor/`.
- `./bin/athanor` is on PATH or invokable.
- The user has authorised real-token enrichment runs (each task is one
  Sonnet enrichment + one Opus critic call, plus retries).

## Recipe

### 1. Read the source plan in full

Read the Markdown plan end-to-end before doing anything else. You need
the whole architectural picture so the task breakdown is well-bounded
and the descriptions reference real symbols / files.

### 2. Distill the plan into 5–15 focused tasks

Each task should:
- Touch one module, one concern, or one well-defined refactor step.
- Be implementable independently once its prerequisites have landed.
- Have a description rich enough (300–600 words) that Sonnet's
  enrichment can produce concrete acceptance criteria, allowedPaths,
  and gates without needing to invent architectural decisions.

Order tasks by dependency. Earlier tasks define interfaces / types;
later tasks consume them. A common shape:

1. Foundation refactors (extract helpers, define interfaces).
2. Schema / type changes.
3. Implementations of the new abstractions.
4. Rewires / call-site updates.
5. New backends / capabilities that depend on the foundation.
6. Documentation / final polish.

### 3. Hand-author `.athanor/plans/<id>.yaml`

Write a `PlanSpec` YAML at `.athanor/plans/<id>.yaml` with:

```yaml
id: kebab-case-id
name: Human-readable plan name
description: |
  Why this is being done. Constraints. Architectural decisions
  already made. The enrichment critic reads this when checking
  cross-task consistency.
tasks:
  - id: kebab-case-task-id
    description: |
      Detailed prose describing what this task accomplishes,
      which files it touches, and any signatures / type names
      / file paths it must use to stay consistent with sibling
      tasks. Include code snippets where they pin the contract.
    overrides:
      # Use overrides ONLY where defaults are wrong:
      model: opus              # for cross-cutting / high-stakes tasks
      allowedPaths: ["src/foo.ts", "src/foo.test.ts"]  # tighten scope
      # gates: …               # only override when defaults don't fit
```

Validate the YAML parses before going further:

```ts
import { loadPlanSpec } from './src/plan-spec.js';
const p = await loadPlanSpec('.athanor/plans/<id>.yaml');
console.log(`OK: ${p.id} – ${p.tasks.length} tasks`);
```

### 4. Run enrichment with the critic

```bash
./bin/athanor plan \
  --from-plan .athanor/plans/<id>.yaml \
  --enrichment-critic \
  --critic-max-retries 2 \
  --stop-after tasks
```

This invokes Sonnet to enrich each task and Opus to critic each
enriched spec, with up to two re-enrichment retries per task. The
critic sees every already-enriched sibling so it can flag cross-task
drift in file paths, type names, and signatures. Tasks that exhaust
retries are written with a `# CRITIC OVERRIDDEN` header listing the
unresolved issues.

### 5. Audit the output

After enrichment finishes, inspect `.athanor/tasks/<plan-id>/*.yaml`:

- Look for any file whose first line starts with `# ── CRITIC OVERRIDDEN`.
  Those have residual issues. Read the listed issues and decide whether
  to hand-edit or re-run with higher `--critic-max-retries`.
- For approved specs, spot-check 2–3 to confirm acceptance criteria
  reference concrete file paths and aren't generic placeholders.
- Run `./bin/athanor plan --from-plan <path> --re-critic` for an
  independent audit pass over all specs at once.

### 6. Hand off

Once the user is satisfied with the task specs, they can run:

```bash
./bin/athanor run-plan .athanor/plans/<id>.yaml
```

This is real-token execution — get explicit user authorisation before
running it.

## Failure modes and how to recover

- **YAML parse failures during enrichment.** The planner now retries
  once per call; if it still fails, the run aborts. Re-run with the
  same arguments — Sonnet's output is non-deterministic and a second
  attempt usually parses.
- **Cross-task drift the critic can't reconcile.** If a particular
  task can't pass the critic in 2 retries, the resulting spec has
  the unresolved issues in its header comment. Either hand-edit the
  description to be more specific about the disputed contract, or
  raise `--critic-max-retries` and re-run.
- **Whole-plan inconsistency.** When several tasks contradict each
  other's interfaces, the cleanest fix is to wipe `.athanor/tasks/<id>/`
  entirely and re-run enrichment from scratch — the order-dependent
  sibling-context resolves drift as long as the first task in the plan
  defines the canonical interfaces.

## Things to avoid

- Do NOT pass the Markdown plan as a `prompt` argument to `athanor plan`
  (without `--from-plan`). That regenerates a plan from scratch via
  Opus and overwrites your hand-authored file.
- Do NOT add overrides for fields that the defaults already handle
  correctly. Sonnet's enrichment + the critic produce better output
  when overrides are sparse and intentional.
- Do NOT include the `e2e` gate in task overrides. AGENTS.md forbids
  e2e by default; the project default already excludes it. Tasks that
  genuinely need e2e coverage should be flagged separately to the
  user before adding the gate.
- Do NOT run `athanor run-plan` without explicit user authorisation —
  it spends real tokens for every task.

## Related athanor surfaces

- `src/planner.ts` — the enrichment orchestration.
- `src/enrichment-critic.ts` — the per-task critic.
- `src/evaluator-prompt.ts:buildEnrichmentCriticPrompt` — the critic
  prompt that determines what counts as a problem.
- `.athanor/task.default.yaml` — default gates and model inherited by
  every enriched task.
- `runs/plan-<timestamp>/run-*.log` — full audit trail of every run,
  including every critic decision and re-enrichment attempt.
