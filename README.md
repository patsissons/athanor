<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark-256.png">
    <img alt="Athanor logo" src="docs/brand/logo-256.png" width="160">
  </picture>
</p>

<h1 align="center">Athanor</h1>

<p align="center">
  <em>A harness for driving Claude Code to implement features against well-defined tasks.</em>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#advanced-walkthrough">Advanced walkthrough</a> ·
  <a href="#design-principles">Design principles</a> ·
  <a href="#modules">Modules</a>
</p>

## Quickstart

1. **Clone Athanor and link the binary:**

   ```bash
   git clone https://github.com/patsissons/athanor.git
   cd athanor && npm ci
   ln -s "$PWD/bin/athanor" ~/bin/athanor   # or any directory on your PATH
   ```

2. **Add the minimal config files to your project:**

   ```bash
   cd /path/to/my-project
   mkdir -p .athanor/tasks
   ```

   **`.athanor/app.yaml`** — identifies your project to the harness:

   ```yaml
   id: my-app
   title: My App
   description: A short description of what this project does.
   ```

   **`.athanor/tasks/my-first-task.yaml`** — describes the work you want done:

   ```yaml
   id: my-first-task
   title: My first task
   description: |
     Describe what you want the agent to implement.

   allowedPaths:
     - "src/**"

   acceptanceCriteria:
     - "The feature works as described"
   ```

   See `.athanor/tasks/example.yaml` after running `athanor init` for a fully annotated example with all available fields.

3. **Run the task:**

   ```bash
   athanor run .athanor/tasks/my-first-task.yaml
   ```

   The harness creates an isolated git worktree, runs Claude Code inside it, validates the result against your gates, and commits on success.

4. **Clean up the worktree when you're done:**

   ```bash
   athanor clean --all
   ```

   This removes all worktrees created by the harness. Use `--dry-run` to preview what would be removed.

## Usage

The harness can be invoked two ways:

- **`npm run harness --`** — from within the harness repo itself (uses `tsx` directly).
- **`bin/athanor`** — a standalone script that can be run from any target repository. It resolves the harness root automatically, so you can symlink or alias it:

```bash
# symlink into your PATH (one-time setup)
ln -s /path/to/athanor/bin/athanor ~/bin/athanor

# then run from any target repo
cd /path/to/my-project
athanor plan "Add a favorites feature"
```

All examples below use `athanor` directly, but `npm run harness --` works identically when run from the harness directory.

## Commands

```bash
# scaffold .athanor/ directory in a new project (interactive wizard)
athanor init

# plan + enrich from a prompt
athanor plan "Add a favorites feature"

# plan only (generate the plan YAML)
athanor plan "Add favorites" --stop-after plan

# plan + enrich tasks (skip execution)
athanor plan "Add favorites" --stop-after tasks

# plan with enrichment critic (adversarial task spec review)
athanor plan "Add favorites" --enrichment-critic

# plan + enrich + immediately execute all tasks
athanor plan "Add favorites" --run-plan

# execute all tasks from an existing plan
athanor run-plan .athanor/plans/add-favorites.yaml
athanor run-plan .athanor/plans/add-favorites.yaml --push

# run a single task directly
athanor run .athanor/tasks/add-demo-page.yaml [--debug]

# clean up old worktrees
athanor clean --all
athanor clean --older-than <hours>
athanor clean --dry-run --all
```

## Architecture

### Plan mode (`plan` subcommand)

Plan mode is a two-phase pipeline. Each phase is independently stoppable via `--stop-after`. Use `--run-plan` to chain directly into execution after enrichment.

```
Phase 1: Plan Generation (Opus)
  prompt  ──→  planning agent  ──→  .athanor/plans/{plan-id}.yaml

Phase 2: Task Enrichment (Sonnet) + optional Critic (Opus)
  plan + app config + defaults  ──→  enrichment agent (per task)  ──→  .athanor/tasks/{plan-id}/{task-id}.yaml
                                          ↑                                      │
                                          └── feedback ── critic (single-pass) ←─┘
```

The harness owns all context assembly. Agents never read YAML files — they receive their full context via prompts and produce YAML as output. The enrichment agent receives:

- The full plan (all tasks in execution order, plan name/description)
- The specific task to enrich (marked in the task list)
- App-level configuration and guidelines (from `.athanor/app.yaml`)
- Task defaults (from `.athanor/task.default.yaml`)
- Optional assets (extensible context the harness can inject)

When `--enrichment-critic` is enabled, each enriched task spec is reviewed by a single-pass critic (Opus by default) that checks for concrete acceptance criteria, tight `allowedPaths`, scope overlap with sibling tasks, and other quality signals. If the critic rejects, the enrichment agent re-enriches with the critic's feedback as an asset. This is a lightweight adversarial loop that improves task spec quality before execution begins.

### Run mode (`run` subcommand)

The orchestrator in `src/orchestrator.ts` executes a single task spec. It delegates to the inner retry loop in `src/task-loop.ts`. Reading those files top to bottom is the fastest way to understand the execution model.

```
[deterministic]  create worktree from main
[deterministic]  npm ci inside worktree
┌─── retry loop (bounded by maxAgentAttempts, default 2, 3 with evaluator) ─┐
│  [agent]        invoke Claude Code (cwd = worktree/)                      │
│  [deterministic] auto-format with Prettier                                │
│  [deterministic] scope check: changed files ⊆ allowedPaths                │
│  [deterministic] forbidden-paths check                                    │
│  [deterministic] run gates (lint, typecheck, test, ...)                   │
│  [agent]        evaluator review (runs even when gates fail)              │
│  [deterministic] if all checks pass: commit + exit OK                     │
│  [deterministic] if anything fails: feed output back, retry               │
└───────────────────────────────────────────────────────────────────────────┘
[deterministic]  on success: push (if requested)
[deterministic]  on exhaustion: leave worktree for human review
```

The agent is invoked at the `[agent]` nodes. Everything else is plain TypeScript with subprocess exit codes. Commits happen only after both gates and evaluator pass. The evaluator always runs (even on gate failure) so the agent gets comprehensive feedback on the next retry.

### Run-plan mode (`run-plan` subcommand)

Executes all tasks from a plan sequentially in a single worktree branch.

```
[deterministic]  load plan spec
[deterministic]  pre-check: cross-reference completed-tasks.yaml with git history
[deterministic]  create worktree on athanor/{planId}/{runId} branch
[deterministic]  npm ci inside worktree
┌─── outer task loop (from resume point) ────────────────────────────────┐
│  [deterministic] load + merge task spec                                │
│  [deterministic] build completed-tasks context from prior tasks        │
│  ┌─── inner retry loop (via task-loop.ts) ──────────────────────────┐  │
│  │  agent → format → paths → gates → eval → commit on full success  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  [deterministic] on success: append to .athanor/completed-tasks.yaml   │
│  [deterministic] on failure: halt, leave worktree for human review     │
└────────────────────────────────────────────────────────────────────────┘
[deterministic]  on all tasks complete: push (if --push)
```

**Resumption:** `.athanor/completed-tasks.yaml` tracks completed task IDs locally (never committed). On restart, the harness cross-references this file with git history — both must agree for a task to be considered complete. Any mismatch is a hard failure with a clear error message. This ensures safe resume after crashes or interruptions.

## Modules

| File                       | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `src/cli.ts`               | Commander-based CLI (`run`, `plan`, `run-plan`, `clean`, `init`)      |
| `src/init.ts`              | Interactive scaffolding wizard using @clack/prompts                   |
| `src/planner.ts`           | Two-phase plan pipeline (generate, enrich)                            |
| `src/plan-prompt.ts`       | Prompt construction for plan generation and task enrichment           |
| `src/orchestrator.ts`      | Single-task execution (worktree, npm install, delegates to task-loop) |
| `src/task-loop.ts`         | Inner retry loop primitive (agent, gates, eval, commit)               |
| `src/run-plan.ts`          | Sequential plan execution with pre-check and resume support           |
| `src/completed-tasks.ts`   | Completed-tasks YAML schema, git scanning, cross-reference logic      |
| `src/app-spec.ts`          | Zod schema for `.athanor/app.yaml` (identity, guidelines, devServer)  |
| `src/plan-spec.ts`         | Zod schema for plan YAML files                                        |
| `src/task-spec.ts`         | Zod schema for task YAML files                                        |
| `src/eval-spec.ts`         | Zod schemas for evaluator config, results, and dev server config      |
| `src/evaluator.ts`         | Evaluator agent invocation (diff-review and interactive modes)        |
| `src/evaluator-prompt.ts`  | Prompt construction for evaluator and enrichment critic               |
| `src/enrichment-critic.ts` | Single-pass critic for task spec quality review                       |
| `src/dev-server.ts`        | Dev server lifecycle for interactive evaluator mode                   |
| `src/merge-dev-server.ts`  | Inherits app-level devServer into task evaluator config               |
| `src/plan-defaults.ts`     | Loaders for app, plan, and task default files                         |
| `src/load-defaults.ts`     | Generic YAML defaults loader (graceful on missing files)              |
| `src/prompt.ts`            | Prompt construction for task execution                                |
| `src/agent.ts`             | Claude Code invocation, with optional MCP and stream-json support     |
| `src/worktree.ts`          | Git worktree lifecycle (create, changedFiles, diff, commit, push)     |
| `src/gates.ts`             | Subprocess-based validation gates with truncated output               |
| `src/path-policy.ts`       | Allowed/forbidden path enforcement                                    |
| `src/yaml-extract.ts`      | YAML extraction from agent output (handles markdown fences)           |
| `src/paths.ts`             | Harness root + target repo root resolution                            |
| `src/clean.ts`             | Worktree and branch cleanup                                           |
| `src/logger.ts`            | File + stdout logging, colorized                                      |

## Configuration files

These files live in the **target repository's `.athanor/` directory** (not the harness):

| File                          | Purpose                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.athanor/app.yaml`           | App-level identity, guidelines, and dev server config. Fields: `id`, `title`, optional `description`, `guidelines`, and `devServer`. When `devServer` is set, the planner automatically uses interactive evaluation for UI tasks. |
| `.athanor/task.default.yaml`  | Default values for task specs (gates, forbidden paths, model, etc.). Merged under every task at load time.                                                                                                                        |
| `.athanor/tasks/example.yaml` | Example standalone task spec (created by `athanor init`).                                                                                                                                                                         |

## Task spec

See `.athanor/tasks/example.yaml` (created by `athanor init`). The schema is defined in `src/task-spec.ts`. Every field exists to reduce the agent's degrees of freedom:

- `description` and `acceptanceCriteria` appear verbatim in the prompt.
- `allowedPaths` / `forbiddenPaths` are enforced as deterministic nodes, not just stated in the prompt.
- `gates` are subprocess commands with exit-code semantics. Pass means pass.
- `guidelines` are optional task-specific guidelines appended to the app-level guidelines.
- `maxAgentAttempts` is capped at 3 with a default of 2 (automatically raised to 3 when an evaluator is enabled). LLMs show diminishing returns on retry.
- `evaluator` enables an optional adversarial review after gates pass. Supports two modes:
  - `diff-review` (default): an independent agent reviews the git diff against acceptance criteria.
  - `interactive`: starts the project's dev server and uses Playwright MCP to test the running application. Requires `devServer` config (`command`, `readyPattern`, `port`).

> **Evaluator vs. enrichment critic.** These are two independent adversarial agents that operate at different phases. The **enrichment critic** (`--enrichment-critic` on `plan`) reviews the _task spec_ before any code is written — it checks for vague acceptance criteria, loose `allowedPaths`, and scope overlap. The **evaluator** (`evaluator.enabled` on a task) reviews the _generated code_ after gates pass. They compose: critic improves the spec the evaluator will later judge against. Use the critic when prompts are fuzzy, the evaluator when tasks are user-visible.

## Design principles

- Deterministic nodes that silently pass are worse than no check at all. Every check gets a negative test.
- The retry feedback loop gets only the gate's output, not any other history. Focused signal beats conversational context.
- Auto-format before gating. Don't spend agent retries on whitespace.
- Full permissions inside the worktree (`--dangerously-skip-permissions`) are safe because the worktree is disposable. Never outside it.
- Agents never read files to get context. The harness assembles all context and injects it via prompts.
- Separate generation from evaluation. The agent that writes code should never judge its own work — an independent evaluator with anti-approval-bias prompting catches issues the generator rationalizes away.

## Adding a task

### Via plan mode (recommended)

1. Run `athanor plan "your feature description" --stop-after tasks` to generate task specs from a prompt.
2. Review the generated specs in `.athanor/tasks/{plan-id}/`.
3. Run `athanor run-plan .athanor/plans/{plan-id}.yaml` to execute.

### Manually

1. Write a YAML file in `.athanor/tasks/` following the shape of `example.yaml`.
2. Keep `allowedPaths` as tight as you can. The narrower the scope, the fewer surprises.
3. Make acceptance criteria concrete and testable. "Looks good" is not a criterion. "Route exists, table renders 3 rows with columns X, Y, Z" is.
4. Run with `--debug` the first time so you can watch the agent's reasoning.

## Advanced walkthrough

A complete pass through the harness, exercising plan generation, the enrichment critic, sequential execution, mid-run failure, and resume. The example feature is "add a favorites list" against a small Next.js app.

**1. Plan with adversarial enrichment.** Generate a plan and stop after enrichment so you can review specs before any code runs. `--enrichment-critic` enables a single-pass adversarial review of each enriched task spec.

```bash
athanor plan "Add a favorites list with a star toggle and persistent storage" \
  --enrichment-critic --stop-after tasks
```

The harness writes `.athanor/plans/add-favorites.yaml` (the plan) and one task spec per item under `.athanor/tasks/add-favorites/`. When the critic rejects a task spec — e.g. for a vague criterion like _"works correctly"_ or `allowedPaths: ["src/**"]` that overlaps with sibling tasks — the enrichment agent re-runs with the critic's feedback as context. You'll see lines like:

```
[critic]   reject: criterion 1 is not testable ("works correctly")
[enrich]   re-running with critic feedback (attempt 2/2)
[critic]   approved
```

**2. Execute the plan.** Run all tasks sequentially in a single worktree branch. The harness creates `athanor/add-favorites/<runId>` and walks the plan top-to-bottom.

```bash
athanor run-plan .athanor/plans/add-favorites.yaml
```

Each task runs through the full retry loop: agent → format → path policy → gates → evaluator → commit. On success, the task is appended to `.athanor/completed-tasks.yaml` (local-only, never committed). After two clean tasks the file looks like:

```yaml
tasks:
  - id: add-favorites-store
    title: Add favorites localStorage helper
    commitHash: 8f3a4c1...
    timestamp: 2026-04-28T14:12:31.004Z
    summary: Added src/lib/storage/favorites.ts with get/set helpers and tests.
  - id: add-star-toggle
    title: Add star toggle component
    commitHash: a12b9e5...
    timestamp: 2026-04-28T14:18:02.117Z
    summary: Added FavoriteToggle that wires localStorage to a star button.
```

**3. Resume after a failure.** Imagine the third task (`add-favorites-page`) exhausts its retry budget — the evaluator keeps rejecting because the empty-state isn't covered. The harness halts and leaves the worktree intact for inspection.

After fixing the spec (tightening criteria, adding an acceptance criterion for the empty state), rerun the same command:

```bash
athanor run-plan .athanor/plans/add-favorites.yaml
```

On startup the harness cross-references `completed-tasks.yaml` against git history (`git log --grep="Task: "`). Both sources must agree — any mismatch is a hard error. With both in sync, execution resumes at task 3 with the prior two tasks injected as completed-context for the agent.

**4. Push the branch.** When the run finishes cleanly, push with:

```bash
athanor run-plan .athanor/plans/add-favorites.yaml --push
```

Choosing the right evaluator mode: `diff-review` is the right default for backend, schema, or library tasks where reading the diff is sufficient. `interactive` is worth the dev-server spin-up cost when acceptance criteria are visual or behavioral (rendering, click handlers, persistence across reloads) — see `.athanor/tasks/example-interactive.yaml` for a complete config.
