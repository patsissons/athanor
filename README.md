# Athanor

A harness for driving Claude Code to implement features against well-defined tasks.

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
   athanor run tasks/my-first-task.yaml
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

# plan + enrich + execute from a prompt
athanor plan "Add a favorites feature"

# plan only (generate the plan YAML)
athanor plan "Add favorites" --stop-after plan

# plan + enrich tasks (skip execution)
athanor plan "Add favorites" --stop-after tasks

# plan with enrichment critic (adversarial task spec review)
athanor plan "Add favorites" --enrichment-critic

# resume from an existing plan (skip plan generation)
athanor plan --from-plan .athanor/plans/add-favorites.yaml

# run a single task directly
athanor run .athanor/tasks/add-demo-page.yaml [--debug]

# clean up old worktrees
athanor clean --all
athanor clean --older-than <hours>
athanor clean --dry-run --all
```

## Architecture

### Plan mode (`plan` subcommand)

Plan mode is a three-phase pipeline. Each phase is independently stoppable via `--stop-after`.

```
Phase 1: Plan Generation (Opus)
  prompt  ──→  planning agent  ──→  .athanor/plans/{plan-id}.yaml

Phase 2: Task Enrichment (Sonnet) + optional Critic (Opus)
  plan + app config + defaults  ──→  enrichment agent (per task)  ──→  .athanor/tasks/{plan-id}/{task-id}.yaml
                                          ↑                                      │
                                          └── feedback ── critic (single-pass) ←─┘

Phase 3: Task Execution
  task specs  ──→  orchestrator (per task)  ──→  worktree + commit
```

The harness owns all context assembly. Agents never read YAML files — they receive their full context via prompts and produce YAML as output. The enrichment agent receives:

- The full plan (all tasks in execution order, plan name/description)
- The specific task to enrich (marked in the task list)
- App-level configuration and guidelines (from `.athanor/app.yaml`)
- Task defaults (from `.athanor/task.default.yaml`)
- Optional assets (extensible context the harness can inject)

When `--enrichment-critic` is enabled, each enriched task spec is reviewed by a single-pass critic (Opus by default) that checks for concrete acceptance criteria, tight `allowedPaths`, scope overlap with sibling tasks, and other quality signals. If the critic rejects, the enrichment agent re-enriches with the critic's feedback as an asset. This is a lightweight adversarial loop that improves task spec quality before execution begins.

### Run mode (`run` subcommand)

The orchestrator in `src/orchestrator.ts` executes a single task spec. Reading that file top to bottom is the fastest way to understand the execution model.

```
[deterministic]  create worktree from main
[deterministic]  npm ci inside worktree
┌─── retry loop (bounded by task.maxAgentAttempts, default 2) ───┐
│  [agent]        invoke Claude Code (cwd = worktree/)           │
│  [deterministic] auto-format with Prettier                     │
│  [deterministic] scope check: changed files ⊆ allowedPaths     │
│  [deterministic] forbidden-paths check                         │
│  [deterministic] run gates (lint, typecheck, test, ...)        │
│  [agent]        evaluator review (optional, when enabled)      │
│  [deterministic] if all checks pass: commit + push + exit OK   │
│  [deterministic] if anything fails: feed output back, retry    │
└────────────────────────────────────────────────────────────────┘
[deterministic]  on exhaustion: leave worktree for human review
```

The agent is invoked at the `[agent]` nodes. Everything else is plain TypeScript with subprocess exit codes.

## Modules

| File                       | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `src/cli.ts`               | Commander-based CLI (`run`, `plan`, `clean`, `init`)                 |
| `src/init.ts`              | Interactive scaffolding wizard using @clack/prompts                  |
| `src/planner.ts`           | Three-phase plan pipeline (generate, enrich, execute)                |
| `src/plan-prompt.ts`       | Prompt construction for plan generation and task enrichment          |
| `src/orchestrator.ts`      | Single-task execution blueprint (worktree, agent, gates, retry)      |
| `src/app-spec.ts`          | Zod schema for `.athanor/app.yaml` (identity, guidelines, devServer) |
| `src/plan-spec.ts`         | Zod schema for plan YAML files                                       |
| `src/task-spec.ts`         | Zod schema for task YAML files                                       |
| `src/eval-spec.ts`         | Zod schemas for evaluator config, results, and dev server config     |
| `src/evaluator.ts`         | Evaluator agent invocation (diff-review and interactive modes)       |
| `src/evaluator-prompt.ts`  | Prompt construction for evaluator and enrichment critic              |
| `src/enrichment-critic.ts` | Single-pass critic for task spec quality review                      |
| `src/dev-server.ts`        | Dev server lifecycle for interactive evaluator mode                  |
| `src/merge-dev-server.ts`  | Inherits app-level devServer into task evaluator config              |
| `src/plan-defaults.ts`     | Loaders for app, plan, and task default files                        |
| `src/load-defaults.ts`     | Generic YAML defaults loader (graceful on missing files)             |
| `src/prompt.ts`            | Prompt construction for task execution                               |
| `src/agent.ts`             | Claude Code invocation, with optional MCP and stream-json support    |
| `src/worktree.ts`          | Git worktree lifecycle (create, changedFiles, diff, commit, push)    |
| `src/gates.ts`             | Subprocess-based validation gates with truncated output              |
| `src/path-policy.ts`       | Allowed/forbidden path enforcement                                   |
| `src/yaml-extract.ts`      | YAML extraction from agent output (handles markdown fences)          |
| `src/paths.ts`             | Harness root + target repo root resolution                           |
| `src/clean.ts`             | Worktree and branch cleanup                                          |
| `src/logger.ts`            | File + stdout logging, colorized                                     |

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
- `maxAgentAttempts` is capped at 3 with a default of 2. LLMs show diminishing returns on retry.
- `evaluator` enables an optional adversarial review after gates pass. Supports two modes:
  - `diff-review` (default): an independent agent reviews the git diff against acceptance criteria.
  - `interactive`: starts the project's dev server and uses Playwright MCP to test the running application. Requires `devServer` config (`command`, `readyPattern`, `port`).

## Design principles

- Deterministic nodes that silently pass are worse than no check at all. Every check gets a negative test.
- The retry feedback loop gets only the gate's output, not any other history. Focused signal beats conversational context.
- Auto-format before gating. Don't spend agent retries on whitespace.
- Full permissions inside the worktree (`--dangerously-skip-permissions`) are safe because the worktree is disposable. Never outside it.
- Agents never read files to get context. The harness assembles all context and injects it via prompts.
- Separate generation from evaluation. The agent that writes code should never judge its own work — an independent evaluator with anti-approval-bias prompting catches issues the generator rationalizes away.

## Adding a task

### Via plan mode (recommended)

1. Run `npm run harness -- plan "your feature description" --stop-after tasks` to generate task specs from a prompt.
2. Review the generated specs in `.athanor/tasks/{plan-id}/`.
3. Run `npm run harness -- plan --from-plan .athanor/plans/{plan-id}.yaml` to execute.

### Manually

1. Write a YAML file in `.athanor/tasks/` following the shape of `example.yaml`.
2. Keep `allowedPaths` as tight as you can. The narrower the scope, the fewer surprises.
3. Make acceptance criteria concrete and testable. "Looks good" is not a criterion. "Route exists, table renders 3 rows with columns X, Y, Z" is.
4. Run with `--debug` the first time so you can watch the agent's reasoning.
