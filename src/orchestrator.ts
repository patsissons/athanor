import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import type { TaskSpec } from "./task-spec.js";
import type { EvalResult, EvaluatorConfig } from "./eval-spec.js";
import { Worktree, makeRunId } from "./worktree.js";
import { runAllGates, summarize, type GateResult } from "./gates.js";
import { invokeClaudeCode } from "./agent.js";
import { runEvaluator, formatEvalFeedback } from "./evaluator.js";
import { buildPrompt } from "./prompt.js";
import { log } from "./logger.js";
import { evaluatePathPolicy } from "./path-policy.js";

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

export interface RunTaskDeps {
  createWorktree(
    targetRepoRoot: string,
    harnessRoot: string,
    taskId: string,
    runId: string,
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
  loadCompletedTasks(targetRepoRoot: string): Promise<string | undefined>;
  appendCompletedTask(
    targetRepoRoot: string,
    taskId: string,
    taskTitle: string,
    summary: string,
  ): Promise<void>;
  log: RunTaskLogger;
}

function createDefaultWorktree(
  targetRepoRoot: string,
  harnessRoot: string,
  taskId: string,
  runId: string,
): WorktreeLike {
  return new Worktree(targetRepoRoot, harnessRoot, taskId, runId);
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
  loadCompletedTasks,
  appendCompletedTask,
  log,
};

async function loadCompletedTasks(targetRepoRoot: string): Promise<string | undefined> {
  const summaryPath = resolve(targetRepoRoot, "tasks", "completed-tasks.md");
  try {
    return await readFile(summaryPath, "utf8");
  } catch {
    return undefined;
  }
}

async function appendCompletedTask(
  targetRepoRoot: string,
  taskId: string,
  taskTitle: string,
  summary: string,
): Promise<void> {
  const tasksDir = resolve(targetRepoRoot, "tasks");
  await mkdir(tasksDir, { recursive: true });
  const summaryPath = join(tasksDir, "completed-tasks.md");

  let existing = "";
  try {
    existing = await readFile(summaryPath, "utf8");
  } catch {
    // File does not exist yet; start fresh.
  }

  const section = `## ${taskId}: ${taskTitle}\n\n${summary}\n`;
  const updated = existing ? `${existing.trimEnd()}\n\n${section}` : section;
  await writeFile(summaryPath, updated);

  await execa("git", ["add", join("tasks", "completed-tasks.md")], { cwd: targetRepoRoot });
  await execa("git", ["commit", "-m", `chore: update completed-tasks.md for ${taskId}`], {
    cwd: targetRepoRoot,
  });
}

export async function runTask(
  task: TaskSpec,
  opts: { targetRepoRoot: string; harnessRoot: string },
  deps: Partial<RunTaskDeps> = {},
): Promise<boolean> {
  /*
   * Blueprint:
   *   [deterministic] create worktree from main
   *   [agent]         attempt N: implement the task (cwd = worktree root)
   *   [deterministic] check changed files against allowedPaths
   *   [deterministic] run all gates (cwd = worktree root)
   *   [agent]         attempt N+1 (only if gates failed): fix failures
   *   [deterministic] commit + push if passing, else surface to human
   */
  const runtime = { ...defaultDeps, ...deps };

  runtime.log.info(`Starting task: ${task.id} (using ${task.model})`);

  // ─── DETERMINISTIC NODE: load previously completed tasks ────
  const completedTasks = await runtime.loadCompletedTasks(opts.targetRepoRoot);
  const taskWithContext: TaskSpec = completedTasks ? { ...task, completedTasks } : task;

  const wt = runtime.createWorktree(
    opts.targetRepoRoot,
    opts.harnessRoot,
    task.id,
    runtime.makeRunId(),
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
    return false;
  }
  runtime.log.debug("Dependencies installed");

  let priorFailure: string | null = null;
  let lastSummary: string | undefined;

  for (let attempt = 1; attempt <= task.maxAgentAttempts; attempt++) {
    // ─── AGENT NODE ──────────────────────────────────────────────
    runtime.log.info(`Agent attempt ${attempt}/${task.maxAgentAttempts}`);
    const prompt = buildPrompt({ task: taskWithContext, attempt, priorFailure });
    const agentResult = await runtime.invokeAgent({
      prompt,
      cwd: wt.path,
      model: task.model,
    });
    if (!agentResult.success) {
      runtime.log.error(`Agent invocation failed: ${agentResult.stderr}`);
      return false;
    }

    lastSummary = agentResult.summary;

    // ─── DETERMINISTIC NODE: auto-format ─────────────────────────
    runtime.log.debug("Running Prettier");
    const fmtResult = await runtime.runCommand("npm", ["run", "format"], {
      cwd: wt.path,
      timeoutMs: 60 * 1000,
    });
    if (fmtResult.exitCode !== 0) {
      runtime.log.warn(`Prettier failed: ${fmtResult.stderr}`);
      // Don't fail the run on prettier itself failing; let gates catch real issues.
    }

    const changed = await wt.changedFiles();
    const pathPolicy = evaluatePathPolicy(changed, task.allowedPaths, task.forbiddenPaths);
    if (!pathPolicy.ok) {
      priorFailure = pathPolicy.message;
      runtime.log.warn(priorFailure ?? "Path policy failed");
      continue;
    }

    // ─── DETERMINISTIC NODE: run gates ───────────────────────────
    runtime.log.info("Running validation gates");
    const results = await runtime.runAllGates(task.gates, wt.path);
    results.forEach((r) => runtime.log.debug(summarize(r)));

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      // Focused failure message for the next attempt
      priorFailure = failed
        .map((r) => `=== ${r.name} (exit ${r.exitCode}) ===\n${r.output}`)
        .join("\n\n");
      continue;
    }

    runtime.log.info("All gates passed");

    // ─── AGENT NODE: evaluator (optional) ────────────────────────
    if (task.evaluator?.enabled) {
      if (task.evaluator.mode === "interactive" && !task.evaluator.devServer) {
        runtime.log.error(
          "Evaluator mode is 'interactive' but no devServer config found. " +
            "Set devServer in the task spec or in tasks/app.yaml.",
        );
        return false;
      }
      runtime.log.info(`Running evaluator (${task.evaluator.model})`);
      const diffText = await wt.diff();
      const evalResult = await runtime.runEvaluator({
        task: taskWithContext,
        diff: diffText,
        evaluator: task.evaluator,
        cwd: wt.path,
      });

      if (!evalResult.passed) {
        runtime.log.warn(
          `Evaluator rejected (score: ${evalResult.score ?? "N/A"}): ${evalResult.summary}`,
        );
        priorFailure = formatEvalFeedback(evalResult);
        continue;
      }

      runtime.log.info(`Evaluator approved (score: ${evalResult.score ?? "N/A"})`);
    }

    // ─── DETERMINISTIC NODE: record completed task summary ──────
    const summary = lastSummary ?? `Completed task: ${task.title}`;
    await runtime.appendCompletedTask(opts.targetRepoRoot, task.id, task.title, summary);
    runtime.log.debug("Updated completed-tasks.md");

    // ─── DETERMINISTIC NODE: commit + push ─────────────────────
    await wt.commitAll(`${task.title}\n\nTask: ${task.id}`);
    try {
      await wt.push();
      runtime.log.info(`Pushed branch ${wt.branch}`);
    } catch (e) {
      runtime.log.warn(`Push failed (maybe no remote configured): ${String(e)}`);
    }
    return true;
  }

  runtime.log.warn(
    `Task ${task.id} did not pass after ${task.maxAgentAttempts} attempts. ` +
      `Branch ${wt.branch} left for human review at ${wt.path}.`,
  );
  return false;
}
