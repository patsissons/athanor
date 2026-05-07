# athanor (harness)

A harness for driving Claude Code to implement features against well defined tasks.

## Core rules

- Always run `npm run format-and-validate` to validate your code before committing. This single command covers formatting, type checking, linting, and tests — do not run any of these separately as an additional verification step.
- Avoid running end-to-end tests unless you are explicitly asked to do so. these cost real tokens to run. If you need to run them, ask the user if they want to do so.
- The harness intentionally never runs `--dangerously-skip-permissions` outside a disposable worktree. This fact must never be altered. The flag is hardcoded inside `buildClaudeArgs`/`runClaudeCli` (`src/agent.ts`) and is never surfaced as a config option, parameter, or environment variable, regardless of which `IsolationBackend` is active.
- Gates and `npm install` / `npm ci` run inside the chosen `IsolationBackend`, not on the host. With the default `worktree` backend that means execa with `cwd: worktree.path`; with `sandcastle` that means a command inside the bind-mounted Docker/Podman container.

## Architecture

- The architecture is described in detail inside the `README.md` file, but you should only read it if you need to fully understand the architecture of the harness. in most cases you should be able to understand the necessary details from the context of the code you are reading.
- The harness has three execution modes: `run` (single task — `src/orchestrator.ts` → `src/task-loop.ts`), `plan` (generate + enrich task specs — `src/planner.ts`), and `run-plan` (sequential execution with resume — `src/run-plan.ts`). Read those files top-to-bottom before reasoning about cross-cutting changes.
- Agent isolation lives behind the `IsolationBackend` interface in `src/isolation/`. Two backends ship: `WorktreeBackend` (host execa with `cwd: worktree.path`) and `SandcastleBackend` (Docker/Podman container, `@ai-hero/sandcastle`). `task-loop.ts` and `orchestrator.ts` interact with the backend only — they do not know whether a container is involved.
- Two independent adversarial agents exist: the **enrichment critic** (`src/enrichment-critic.ts`) reviews task specs before execution; the **evaluator** (`src/evaluator.ts`) reviews generated code after gates pass. They are not the same and live behind different config flags — keep them distinct when editing prompts or schemas.
- Resume safety for `run-plan` depends on git history and `.athanor/completed-tasks.yaml` agreeing. Any change that touches `src/completed-tasks.ts` or commit/push behaviour in `src/worktree.ts` (or its wrapper `src/isolation/worktree-backend.ts`) must preserve the cross-reference invariant.
