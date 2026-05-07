import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import type { PlanSpec } from "./plan-spec.js";
import { loadPlanSpec } from "./plan-spec.js";
import { loadTaskSpec, type TaskSpec } from "./task-spec.js";
import { loadAppDefaults } from "./plan-defaults.js";
import type { AppSpec } from "./app-spec.js";
import { mergeAppDevServer } from "./merge-dev-server.js";
import type { EvalResult, EvaluatorConfig } from "./eval-spec.js";
import type { GateResult, GateCommandRunner } from "./gates.js";
import { runAllGates } from "./gates.js";
import { invokeClaudeCode } from "./agent.js";
import { makeRunId } from "./worktree.js";
import { runTaskLoop } from "./task-loop.js";
import {
  resolveIsolationConfig,
  createIsolationBackend,
  type IsolationBackend,
  type IsolationBackendArgs,
  type IsolationConfig,
} from "./isolation/index.js";
import {
  loadCompletedTasks,
  appendCompletedTask,
  scanGitForTaskIds,
  crossReferenceCompletedTasks,
  formatCompletedTasksContext,
  type CompletedTask,
  type CompletedTasksFile,
  type CrossReferenceResult,
} from "./completed-tasks.js";
import { log as defaultLog } from "./logger.js";
import type { RunTaskLogger } from "./orchestrator.js";

export interface RunPlanDeps {
  /** Construct the IsolationBackend for the entire plan run.
   *  Default: the shared factory in src/isolation/index.ts. One backend
   *  is created at plan start and shared across every task — matching
   *  the pre-existing single-shared-worktree model and keeping
   *  branch / commit history coherent across the plan's tasks. */
  createIsolationBackend(
    cfg: IsolationConfig,
    args: IsolationBackendArgs,
  ): Promise<IsolationBackend>;
  makeRunId(): string;
  loadPlanSpec(path: string): Promise<PlanSpec>;
  loadTaskSpec(path: string, targetRepoRoot?: string): Promise<TaskSpec>;
  loadAppDefaults(targetRepoRoot: string): Promise<Partial<AppSpec>>;
  loadCompletedTasks(targetRepoRoot: string): Promise<CompletedTasksFile>;
  appendCompletedTask(targetRepoRoot: string, entry: CompletedTask): Promise<void>;
  scanGitForTaskIds(cwd: string): Promise<Map<string, string>>;
  crossReferenceCompletedTasks(
    yamlTasks: CompletedTask[],
    gitTasks: Map<string, string>,
    planTaskIds: string[],
  ): CrossReferenceResult;
  formatCompletedTasksContext(tasks: CompletedTask[]): string;
  runTaskLoop: typeof runTaskLoop;
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
  readdir(path: string): Promise<string[]>;
  log: RunTaskLogger;
  harnessRoot: string;
  targetRepoRoot: string;
}

async function defaultRunEvaluator(opts: {
  task: TaskSpec;
  diff: string;
  evaluator: EvaluatorConfig;
  cwd: string;
}): Promise<EvalResult> {
  const { runEvaluator: evalFn } = await import("./evaluator.js");
  return evalFn({
    ...opts,
    deps: { invokeAgent: invokeClaudeCode },
  });
}

function buildDefaultDeps(targetRepoRoot: string, harnessRoot: string): RunPlanDeps {
  return {
    createIsolationBackend,
    makeRunId,
    loadPlanSpec,
    loadTaskSpec,
    loadAppDefaults,
    loadCompletedTasks,
    appendCompletedTask,
    scanGitForTaskIds: (cwd) => scanGitForTaskIds(cwd),
    crossReferenceCompletedTasks,
    formatCompletedTasksContext,
    runTaskLoop,
    runAllGates,
    runEvaluator: defaultRunEvaluator,
    readdir: (path) => readdir(path),
    log: defaultLog,
    harnessRoot,
    targetRepoRoot,
  };
}

export async function runPlanExecution(
  planPath: string,
  opts: { targetRepoRoot: string; harnessRoot: string; push?: boolean },
  deps: Partial<RunPlanDeps> = {},
): Promise<boolean> {
  const d: RunPlanDeps = {
    ...buildDefaultDeps(opts.targetRepoRoot, opts.harnessRoot),
    ...deps,
  };

  // ─── Load plan ────────────────────────────────────────────────
  d.log.info(`Loading plan from ${planPath}`);
  const plan = await d.loadPlanSpec(planPath);
  d.log.info(`Plan "${plan.name ?? plan.id}" contains ${plan.tasks.length} task(s)`);

  const planTaskIds = plan.tasks.map((t) => t.id);

  // ─── Resolve task files ───────────────────────────────────────
  const tasksDir = resolve(d.targetRepoRoot, ".athanor", "tasks", plan.id);
  let taskFiles: string[];
  try {
    taskFiles = (await d.readdir(tasksDir)).filter((f) => f.endsWith(".yaml")).sort();
  } catch {
    d.log.error(`Task directory not found: ${tasksDir}. Run 'athanor plan' first.`);
    return false;
  }

  if (taskFiles.length === 0) {
    d.log.error(`No task files found in ${tasksDir}. Run 'athanor plan' first.`);
    return false;
  }

  // ─── Pre-check: cross-reference completed tasks ────────────────
  d.log.info("Running pre-check: cross-referencing completed tasks");
  const completedTasksFile = await d.loadCompletedTasks(d.targetRepoRoot);
  const gitTasks = await d.scanGitForTaskIds(d.targetRepoRoot);
  const crossRef = d.crossReferenceCompletedTasks(completedTasksFile.tasks, gitTasks, planTaskIds);

  if (!crossRef.valid) {
    d.log.error("Pre-check failed: completed tasks state is inconsistent");
    for (const error of crossRef.errors) {
      d.log.error(`  ${error}`);
    }
    return false;
  }

  if (crossRef.resumeIndex >= planTaskIds.length) {
    d.log.info("All tasks in the plan are already completed");
    return true;
  }

  if (crossRef.resumeIndex > 0) {
    d.log.info(
      `Resuming from task ${planTaskIds[crossRef.resumeIndex]} ` +
        `(${crossRef.resumeIndex} task(s) already completed)`,
    );
  }

  // ─── Load app defaults ────────────────────────────────────────
  const appDefaults = await d.loadAppDefaults(d.targetRepoRoot);

  // ─── Resolve plan-run isolation config ────────────────────────
  // Plan mode runs every task inside ONE shared IsolationBackend so
  // commits accumulate on a single branch (matching today's
  // single-shared-worktree behaviour). Per-task isolation overrides
  // are NOT honored in plan mode — they're meaningful for single-task
  // `athanor run` invocations only. Warn if any task tries to override.
  const isolationConfig = resolveIsolationConfig({
    app: appDefaults.isolation,
    plan: plan.isolation,
  });
  d.log.info(`Isolation backend: ${isolationConfig.backend}`);

  // ─── Create the shared IsolationBackend ───────────────────────
  const runId = d.makeRunId();
  const isolation = await d.createIsolationBackend(isolationConfig, {
    targetRepoRoot: d.targetRepoRoot,
    harnessRoot: d.harnessRoot,
    identifier: plan.id,
    runId,
  });

  let pushSucceeded = false;
  try {
    await isolation.create();
    d.log.info(`Worktree created at ${isolation.path} on branch ${isolation.branch}`);

    // ─── Install dependencies ───────────────────────────────────
    d.log.info("Installing dependencies in worktree");
    const installResult = await isolation.runCommand("npm", ["ci"], {
      timeoutMs: 5 * 60 * 1000,
    });
    if (installResult.exitCode !== 0) {
      d.log.error(`npm ci failed:\n${installResult.stderr}`);
      return false;
    }
    d.log.info("Dependencies installed");

    // ─── Gate runner adapter ────────────────────────────────────
    const gateRunner: GateCommandRunner = async (command, _cwd, timeoutMs) => {
      const result = await isolation.runCommand("sh", ["-c", command], { timeoutMs });
      return {
        exitCode: result.exitCode,
        output: result.stdout + result.stderr,
      };
    };

    // ─── Outer task loop ────────────────────────────────────────
    const completedSoFar: CompletedTask[] = [...completedTasksFile.tasks];

    for (let i = crossRef.resumeIndex; i < planTaskIds.length; i++) {
      const taskId = planTaskIds[i];
      const taskFile = taskFiles.find((f) => f.replace(/\.yaml$/, "") === taskId);
      if (!taskFile) {
        d.log.error(`Task file not found for ${taskId} in ${tasksDir}`);
        return false;
      }

      const taskPath = resolve(tasksDir, taskFile);
      let task = await d.loadTaskSpec(taskPath, d.targetRepoRoot);
      task = mergeAppDevServer(task, appDefaults);

      // Per-task isolation overrides are not honored in plan mode.
      // Surface a warning rather than silently dropping the override.
      if (task.isolation && task.isolation.backend !== isolationConfig.backend) {
        d.log.warn(
          `Task ${task.id} declares isolation.backend=${task.isolation.backend}, ` +
            `but plan-mode uses one shared backend (${isolationConfig.backend}); ` +
            `task-level override ignored. Use \`athanor run\` for per-task isolation.`,
        );
      }

      d.log.info(`Running task ${i + 1}/${planTaskIds.length}: ${task.id}`);

      // Compute maxAttempts (3 if evaluator enabled, 2 otherwise)
      const maxAttempts =
        task.evaluator?.enabled && task.maxAgentAttempts === 2 ? 3 : task.maxAgentAttempts;

      // Build completed tasks context
      const completedTasksContext =
        completedSoFar.length > 0 ? d.formatCompletedTasksContext([...completedSoFar]) : undefined;

      // Run the inner retry loop
      const loopResult = await d.runTaskLoop(
        task,
        { maxAttempts, completedTasks: completedTasksContext },
        {
          isolation,
          runAllGates: (gates) => d.runAllGates(gates, isolation.path, gateRunner),
          runEvaluator: d.runEvaluator,
          log: d.log,
        },
      );

      if (!loopResult.success) {
        d.log.error(
          `Task ${task.id} failed — halting plan execution. ` +
            `Worktree left for human review at ${isolation.path}.`,
        );
        return false;
      }

      // Record completed task
      const entry: CompletedTask = {
        id: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
        summary: loopResult.summary ?? `Completed task: ${task.title}`,
      };
      await d.appendCompletedTask(d.targetRepoRoot, entry);
      completedSoFar.push(entry);

      d.log.info(`Task ${task.id} completed successfully`);
    }

    // ─── Push if requested ──────────────────────────────────────
    // Plan-level push: fires once at plan end, only when all tasks
    // succeeded and the caller asked for it. There is no per-task push.
    if (opts.push) {
      try {
        await isolation.push();
        d.log.info(`Pushed branch ${isolation.branch}`);
        pushSucceeded = true;
      } catch (e) {
        d.log.warn(`Push failed (maybe no remote configured): ${String(e)}`);
      }
    }

    d.log.info("All plan tasks completed successfully");
    return true;
  } finally {
    // Tear down isolation-specific runtime resources (e.g. sandcastle
    // containers). For WorktreeBackend this is a no-op so the host
    // worktree is preserved for inspection — see worktree-backend.ts.
    try {
      await isolation.destroy();
    } catch (e) {
      d.log.warn(`Isolation destroy failed: ${String(e)}`);
    }
    if (opts.push && !pushSucceeded) {
      // pushSucceeded is set above on the happy path; this branch
      // executes when push was attempted but failed (we already
      // logged the warn). No additional action needed here — the
      // catch block above is the source of truth for the warning.
    }
  }
}
