# athanor (harness)

A harness for driving Claude Code to implement features against well defined tasks.

## Core rules

- Always run `npm run format-and-validate` to validate your code before committing. This single command covers formatting, type checking, linting, and tests — do not run any of these separately as an additional verification step.
- Avoid running end-to-end tests unless you are explicitly asked to do so. these cost real tokens to run. If you need to run them, ask the user if they want to do so.
- The harness intentionally never runs `--dangerously-skip-permissions` outside a disposable worktree. This fact must never be altered.

## Architecture

- The architecture is described in detail inside the `README.md` file, but you should only read it if you need to fully understand the architecture of the harness. in most cases you should be able to understand the necessary details from the context of the code you are reading.
- The harness has three execution modes: `run` (single task — `src/orchestrator.ts` → `src/task-loop.ts`), `plan` (generate + enrich task specs — `src/planner.ts`), and `run-plan` (sequential execution with resume — `src/run-plan.ts`). Read those files top-to-bottom before reasoning about cross-cutting changes.
- Two independent adversarial agents exist: the **enrichment critic** (`src/enrichment-critic.ts`) reviews task specs before execution; the **evaluator** (`src/evaluator.ts`) reviews generated code after gates pass. They are not the same and live behind different config flags — keep them distinct when editing prompts or schemas.
- Resume safety for `run-plan` depends on git history and `.athanor/completed-tasks.yaml` agreeing. Any change that touches `src/completed-tasks.ts` or commit/push behavior in `src/worktree.ts` must preserve the cross-reference invariant.
