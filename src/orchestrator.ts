import type { TaskSpec } from "./task-spec.js";
import type { EvalResult, EvaluatorConfig } from "./eval-spec.js";
import { makeRunId } from "./worktree.js";
import { runAllGates, type GateResult } from "./gates.js";
import { invokeClaudeCode } from "./agent.js";
import { runEvaluator } from "./evaluator.js";
import { log } from "./logger.js";
import { runTaskLoop } from "./task-loop.js";
import {
  resolveIsolationConfig,
  createIsolationBackend,
  type IsolationBackend,
  type IsolationBackendArgs,
  type IsolationConfig,
  type WorktreeLike,
} from "./isolation/index.js";
import type { GateCommandRunner } from "./gates.js";

// Re-exported for backwards compatibility with callers that import
// WorktreeLike from "./orchestrator.js". The canonical definition
// lives in src/isolation/index.ts; new code should import from there.
export type { WorktreeLike };

export interface CommandResult {
  exitCode: number | null;
  stderr: string;
}

export interface RunTaskLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface RunTaskResult {
  success: boolean;
  branch: string;
}

export interface RunTaskDeps {
  /** Construct the IsolationBackend for this task. Default: the shared
   *  factory in src/isolation/index.ts, which dispatches on
   *  cfg.backend ("worktree" → WorktreeBackend wrapping a fresh
   *  Worktree; "sandcastle" → SandcastleBackend once that lands).
   *  Tests override this to inject a spy-able backend. */
  createIsolationBackend(
    cfg: IsolationConfig,
    args: IsolationBackendArgs,
  ): Promise<IsolationBackend>;
  makeRunId(): string;
  runAllGates(
    gates: TaskSpec["gates"],
    cwd: string,
    runCommand?: GateCommandRunner,
  ): Promise<GateResult[]>;
  runEvaluator(opts: {
    task: TaskSpec;
    diff: string;
    evaluator: EvaluatorConfig;
    cwd: string;
  }): Promise<EvalResult>;
  log: RunTaskLogger;
}

async function defaultRunEvaluator(opts: {
  task: TaskSpec;
  diff: string;
  evaluator: EvaluatorConfig;
  cwd: string;
}): Promise<EvalResult> {
  return runEvaluator({
    ...opts,
    deps: { invokeAgent: invokeClaudeCode },
  });
}

const defaultDeps: RunTaskDeps = {
  createIsolationBackend,
  makeRunId,
  runAllGates,
  runEvaluator: defaultRunEvaluator,
  log,
};

export async function runTask(
  task: TaskSpec,
  opts: { targetRepoRoot: string; harnessRoot: string; baseBranch?: string; push?: boolean },
  deps: Partial<RunTaskDeps> = {},
): Promise<RunTaskResult> {
  const runtime = { ...defaultDeps, ...deps };

  // Default maxAgentAttempts to 3 when task evaluator is enabled
  const maxAttempts =
    task.evaluator?.enabled && task.maxAgentAttempts === 2 ? 3 : task.maxAgentAttempts;

  runtime.log.info(`Starting task: ${task.id} (using ${task.model})`);

  // Resolve the IsolationConfig from task.isolation only — app- and
  // plan-level merging is wired by run-plan-rewire. For direct runTask
  // invocations, only the task-level field applies.
  const isolationConfig = resolveIsolationConfig({ task: task.isolation });
  const runId = runtime.makeRunId();
  const isolation = await runtime.createIsolationBackend(isolationConfig, {
    targetRepoRoot: opts.targetRepoRoot,
    harnessRoot: opts.harnessRoot,
    identifier: task.id,
    runId,
    baseBranch: opts.baseBranch,
  });

  try {
    await isolation.create();
    runtime.log.debug(`Worktree created at ${isolation.path} on branch ${isolation.branch}`);

    // ─── DETERMINISTIC NODE: warm the worktree ──────────────────
    runtime.log.debug("Installing dependencies in worktree");
    const installResult = await isolation.runCommand("npm", ["install"], {
      timeoutMs: 5 * 60 * 1000,
    });
    if (installResult.exitCode !== 0) {
      runtime.log.error(`npm install failed:\n${installResult.stderr}`);
      return { success: false, branch: isolation.branch };
    }
    runtime.log.debug("Dependencies installed");

    // ─── TASK LOOP: delegate to the shared retry loop ─────────────
    const gateRunner: GateCommandRunner = async (command, _cwd, timeoutMs) => {
      const result = await isolation.runCommand("sh", ["-c", command], { timeoutMs });
      return {
        exitCode: result.exitCode,
        output: result.stdout + result.stderr,
      };
    };

    const loopResult = await runTaskLoop(
      task,
      { maxAttempts },
      {
        isolation,
        runAllGates: (gates) => runtime.runAllGates(gates, isolation.path, gateRunner),
        runEvaluator: runtime.runEvaluator,
        log: runtime.log,
      },
    );

    if (!loopResult.success) {
      return { success: false, branch: isolation.branch };
    }

    if (opts.push !== false) {
      try {
        await isolation.push();
        runtime.log.info(`Pushed branch ${isolation.branch}`);
      } catch (e) {
        runtime.log.warn(`Push failed (maybe no remote configured): ${String(e)}`);
      }
    }
    return { success: true, branch: isolation.branch };
  } finally {
    // Best-effort backend teardown. Container backends rely on this
    // to release Docker resources; the host worktree backend
    // intentionally leaves the worktree on disk for inspection (per
    // src/worktree.ts:Worktree.destroy()).
    try {
      await isolation.destroy();
    } catch (e) {
      runtime.log.warn(`Isolation destroy failed: ${String(e)}`);
    }
  }
}
