import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { execa } from "execa";
import type { PlanSpec } from "./plan-spec.js";
import { loadPlanSpec } from "./plan-spec.js";
import { loadTaskSpec, type TaskSpec } from "./task-spec.js";
import { loadAppDefaults } from "./plan-defaults.js";
import type { AppSpec } from "./app-spec.js";
import { mergeAppDevServer } from "./merge-dev-server.js";
import type { EvalResult, EvaluatorConfig } from "./eval-spec.js";
import type { GateResult } from "./gates.js";
import { runAllGates } from "./gates.js";
import { invokeClaudeCode } from "./agent.js";
import { runEvaluator } from "./evaluator.js";
import { Worktree, makeRunId } from "./worktree.js";
import { runTaskLoop, type TaskLoopResult } from "./task-loop.js";
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
import type { WorktreeLike, CommandResult, RunTaskLogger } from "./orchestrator.js";

export interface RunPlanDeps {
  createWorktree(
    targetRepoRoot: string,
    harnessRoot: string,
    identifier: string,
    runId: string,
  ): WorktreeLike;
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
  runTaskLoop(
    task: TaskSpec,
    opts: { maxAttempts: number; completedTasks?: string },
    deps: {
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
      worktree: WorktreeLike;
      log: RunTaskLogger;
    },
  ): Promise<TaskLoopResult>;
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
  readdir(path: string): Promise<string[]>;
  log: RunTaskLogger;
  harnessRoot: string;
  targetRepoRoot: string;
}

function createDefaultWorktree(
  targetRepoRoot: string,
  harnessRoot: string,
  identifier: string,
  runId: string,
): WorktreeLike {
  return new Worktree(targetRepoRoot, harnessRoot, identifier, runId);
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
  return { exitCode: result.exitCode ?? null, stderr: result.stderr };
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
    createWorktree: createDefaultWorktree,
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
    invokeAgent: invokeClaudeCode,
    runAllGates,
    runEvaluator: defaultRunEvaluator,
    runCommand: runSubprocess,
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

  // ─── Create worktree ──────────────────────────────────────────
  const runId = d.makeRunId();
  const wt = d.createWorktree(d.targetRepoRoot, d.harnessRoot, plan.id, runId);
  await wt.create();
  d.log.info(`Worktree created at ${wt.path} on branch ${wt.branch}`);

  // ─── Install dependencies ─────────────────────────────────────
  d.log.info("Installing dependencies in worktree");
  const installResult = await d.runCommand("npm", ["ci"], {
    cwd: wt.path,
    timeoutMs: 5 * 60 * 1000,
  });
  if (installResult.exitCode !== 0) {
    d.log.error(`npm ci failed:\n${installResult.stderr}`);
    return false;
  }
  d.log.info("Dependencies installed");

  // ─── Outer task loop ──────────────────────────────────────────
  // Build the initial completed tasks context from pre-existing completed tasks
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
        invokeAgent: d.invokeAgent,
        runAllGates: d.runAllGates,
        runEvaluator: d.runEvaluator,
        runCommand: d.runCommand,
        worktree: wt,
        log: d.log,
      },
    );

    if (!loopResult.success) {
      d.log.error(
        `Task ${task.id} failed — halting plan execution. ` +
          `Worktree left for human review at ${wt.path}.`,
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

  // ─── Push if requested ────────────────────────────────────────
  if (opts.push) {
    try {
      await wt.push();
      d.log.info(`Pushed branch ${wt.branch}`);
    } catch (e) {
      d.log.warn(`Push failed (maybe no remote configured): ${String(e)}`);
    }
  }

  d.log.info("All plan tasks completed successfully");
  return true;
}
