import type { TaskSpec } from "./task-spec.js";
import type { EvalResult, EvaluatorConfig } from "./eval-spec.js";
import type { GateResult } from "./gates.js";
import { summarize } from "./gates.js";
import { formatEvalFeedback } from "./evaluator.js";
import { buildPrompt } from "./prompt.js";
import { evaluatePathPolicy } from "./path-policy.js";
import type { WorktreeLike, CommandResult, RunTaskLogger } from "./orchestrator.js";

export interface TaskLoopResult {
  success: boolean;
  summary?: string;
}

export interface TaskLoopDeps {
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
}

export async function runTaskLoop(
  task: TaskSpec,
  opts: {
    maxAttempts: number;
    completedTasks?: string;
  },
  deps: TaskLoopDeps,
): Promise<TaskLoopResult> {
  const { worktree: wt, log: logger } = deps;
  let priorFailure: string | null = null;
  let lastSummary: string | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    // ─── AGENT NODE ──────────────────────────────────────────────
    logger.info(`Agent attempt ${attempt}/${opts.maxAttempts}`);
    const prompt = buildPrompt({
      task,
      attempt,
      priorFailure,
      completedTasks: opts.completedTasks,
    });
    const agentResult = await deps.invokeAgent({
      prompt,
      cwd: wt.path,
      model: task.model,
    });
    if (!agentResult.success) {
      logger.error(`Agent invocation failed: ${agentResult.stderr}`);
      return { success: false };
    }

    lastSummary = agentResult.summary;

    // ─── DETERMINISTIC NODE: auto-format ─────────────────────────
    logger.debug("Running Prettier");
    const fmtResult = await deps.runCommand("npm", ["run", "format"], {
      cwd: wt.path,
      timeoutMs: 60 * 1000,
    });
    if (fmtResult.exitCode !== 0) {
      logger.warn(`Prettier failed: ${fmtResult.stderr}`);
    }

    // ─── DETERMINISTIC NODE: path policy check ───────────────────
    const changed = await wt.changedFiles();
    const pathPolicy = evaluatePathPolicy(changed, task.allowedPaths, task.forbiddenPaths);
    if (!pathPolicy.ok) {
      priorFailure = pathPolicy.message;
      logger.warn(priorFailure ?? "Path policy failed");
      continue;
    }

    // ─── DETERMINISTIC NODE: run gates ───────────────────────────
    logger.info("Running validation gates");
    const results = await deps.runAllGates(task.gates, wt.path);
    results.forEach((r) => logger.debug(summarize(r)));

    const failed = results.filter((r) => !r.passed);
    const gateFailureMessage =
      failed.length > 0
        ? failed.map((r) => `=== ${r.name} (exit ${r.exitCode}) ===\n${r.output}`).join("\n\n")
        : null;

    if (gateFailureMessage) {
      logger.warn("Some gates failed");
    } else {
      logger.info("All gates passed");
    }

    // ─── AGENT NODE: evaluator (optional) ────────────────────────
    let evalFailureMessage: string | null = null;

    if (task.evaluator?.enabled) {
      logger.info(`Running evaluator (${task.evaluator.model})`);
      const diffText = await wt.diff();

      let evalResult: EvalResult;

      // Try interactive mode first; fall back to diff-review if dev server fails
      if (task.evaluator.mode === "interactive") {
        evalResult = await deps.runEvaluator({
          task,
          diff: diffText,
          evaluator: task.evaluator,
          cwd: wt.path,
        });

        // If dev server failed to start, fall back to diff-review
        if (!evalResult.passed && evalResult.summary.startsWith("Failed to start dev server")) {
          logger.warn(
            "Interactive evaluator failed to start dev server, falling back to diff-review",
          );
          evalResult = await deps.runEvaluator({
            task,
            diff: diffText,
            evaluator: { ...task.evaluator, mode: "diff-review" },
            cwd: wt.path,
          });
        }
      } else {
        evalResult = await deps.runEvaluator({
          task,
          diff: diffText,
          evaluator: task.evaluator,
          cwd: wt.path,
        });
      }

      if (!evalResult.passed) {
        logger.warn(
          `Evaluator rejected (score: ${evalResult.score ?? "N/A"}): ${evalResult.summary}`,
        );
        evalFailureMessage = formatEvalFeedback(evalResult);
      } else {
        logger.info(`Evaluator approved (score: ${evalResult.score ?? "N/A"})`);
      }
    }

    // ─── DETERMINISTIC NODE: decide pass/fail ────────────────────
    if (gateFailureMessage && evalFailureMessage) {
      priorFailure = `${gateFailureMessage}\n\n${evalFailureMessage}`;
      continue;
    }
    if (gateFailureMessage) {
      priorFailure = gateFailureMessage;
      continue;
    }
    if (evalFailureMessage) {
      priorFailure = evalFailureMessage;
      continue;
    }

    // ─── DETERMINISTIC NODE: commit all changes ─────────────────
    await wt.commitAll(`${task.title}\n\nTask: ${task.id}`);

    return { success: true, summary: lastSummary };
  }

  logger.warn(
    `Task ${task.id} did not pass after ${opts.maxAttempts} attempts. ` +
      `Worktree left for human review at ${wt.path}.`,
  );
  return { success: false, summary: lastSummary };
}
