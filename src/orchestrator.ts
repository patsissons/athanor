import { execa } from "execa";
import type { TaskSpec } from "./task-spec.js";
import type { EvalResult, EvaluatorConfig } from "./eval-spec.js";
import { Worktree, makeRunId } from "./worktree.js";
import { runAllGates, type GateResult } from "./gates.js";
import { invokeClaudeCode } from "./agent.js";
import { runEvaluator } from "./evaluator.js";
import { log } from "./logger.js";
import { runTaskLoop } from "./task-loop.js";

export interface WorktreeLike {
  readonly branch: string;
  readonly path: string;
  create(): Promise<string>;
  changedFiles(): Promise<string[]>;
  diff(): Promise<string>;
  commitAll(message: string): Promise<void>;
  push(): Promise<void>;
}

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
  createWorktree(
    targetRepoRoot: string,
    harnessRoot: string,
    identifier: string,
    runId: string,
    baseBranch?: string,
  ): WorktreeLike;
  makeRunId(): string;
  invokeAgent(opts: {
    prompt: string;
    cwd: string;
    model: string;
  }): Promise<{ success: boolean; stderr: string; summary?: string }>;
  runAllGates(gates: TaskSpec["gates"], cwd: string): Promise<GateResult[]>;
  runEvaluator(opts: {
    task: TaskSpec;
    diff: string;
    evaluator: EvaluatorConfig;
    cwd: string;
  }): Promise<EvalResult>;
  runCommand(
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number },
  ): Promise<CommandResult>;
  log: RunTaskLogger;
}

function createDefaultWorktree(
  targetRepoRoot: string,
  harnessRoot: string,
  identifier: string,
  runId: string,
  baseBranch?: string,
): WorktreeLike {
  return new Worktree(targetRepoRoot, harnessRoot, identifier, runId, baseBranch);
}

async function runSubprocess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  const result = await execa(command, args, {
    cwd: opts.cwd,
    reject: false,
    timeout: opts.timeoutMs,
  });

  return {
    exitCode: result.exitCode ?? null,
    stderr: result.stderr,
  };
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
  createWorktree: createDefaultWorktree,
  makeRunId,
  invokeAgent: invokeClaudeCode,
  runAllGates,
  runEvaluator: defaultRunEvaluator,
  runCommand: runSubprocess,
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

  const wt = runtime.createWorktree(
    opts.targetRepoRoot,
    opts.harnessRoot,
    task.id,
    runtime.makeRunId(),
    opts.baseBranch,
  );
  await wt.create();
  runtime.log.debug(`Worktree created at ${wt.path} on branch ${wt.branch}`);

  // ─── DETERMINISTIC NODE: warm the worktree ──────────────────
  runtime.log.debug("Installing dependencies in worktree");
  const installResult = await runtime.runCommand("npm", ["install"], {
    cwd: wt.path,
    timeoutMs: 5 * 60 * 1000,
  });
  if (installResult.exitCode !== 0) {
    runtime.log.error(`npm install failed:\n${installResult.stderr}`);
    return { success: false, branch: wt.branch };
  }
  runtime.log.debug("Dependencies installed");

  // ─── TASK LOOP: delegate to the shared retry loop ─────────────
  const loopResult = await runTaskLoop(
    task,
    { maxAttempts },
    {
      invokeAgent: runtime.invokeAgent,
      runAllGates: runtime.runAllGates,
      runEvaluator: runtime.runEvaluator,
      runCommand: runtime.runCommand,
      worktree: wt,
      log: runtime.log,
    },
  );

  if (!loopResult.success) {
    return { success: false, branch: wt.branch };
  }

  if (opts.push !== false) {
    try {
      await wt.push();
      runtime.log.info(`Pushed branch ${wt.branch}`);
    } catch (e) {
      runtime.log.warn(`Push failed (maybe no remote configured): ${String(e)}`);
    }
  }
  return { success: true, branch: wt.branch };
}
