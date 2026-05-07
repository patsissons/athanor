#!/usr/bin/env node
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import { loadTaskSpec } from "./task-spec.js";
import { loadAppDefaults } from "./plan-defaults.js";
import { mergeAppDevServer } from "./merge-dev-server.js";
import { setupLogging, log, enableDebug } from "./logger.js";
import { runTask } from "./orchestrator.js";
import { cleanWorktrees, type CleanOpts } from "./clean.js";
import { harnessRoot, resolveTargetRepoRoot, resolveTaskFilePath } from "./paths.js";
import { runPlan } from "./planner.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();
program
  .name("athanor")
  .description("A harness for driving Claude Code to implement features against well-defined tasks")
  .version(version)
  .option("--debug", "Enable debug logging");

// ── run ──────────────────────────────────────────────────────────
program
  .command("run")
  .description("Execute a single task spec")
  .argument("<task-path>", "Path to task YAML file")
  .action(async (taskPath: string, _opts: unknown, cmd: Command) => {
    if (cmd.optsWithGlobals().debug) enableDebug();

    let targetRepoRoot: string;
    try {
      targetRepoRoot = await resolveTargetRepoRoot(process.cwd());
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }

    const resolvedTaskPath = resolveTaskFilePath(taskPath, targetRepoRoot);
    let task = await loadTaskSpec(resolvedTaskPath, targetRepoRoot);
    const appDefaults = await loadAppDefaults(targetRepoRoot);
    task = mergeAppDevServer(task, appDefaults);
    const runDir = resolve(harnessRoot, "runs", task.id);
    const logFile = await setupLogging(runDir);
    log.info(`Logging to ${logFile}`);
    const { success } = await runTask(task, { targetRepoRoot, harnessRoot });
    process.exit(success ? 0 : 1);
  });

// ── plan ─────────────────────────────────────────────────────────
program
  .command("plan")
  .description("Generate a plan and enrich task specs")
  .argument("[prompt]", "The planning prompt (omit when using --from-plan)")
  .option("--from-plan <path>", "Skip plan generation; enrich an existing plan YAML")
  .option("--stop-after <phase>", "Stop after phase (plan or tasks)")
  .option("--enrichment-critic", "Enable enrichment critic for task specs")
  .option(
    "--enrichment-model <model>",
    "Model used to enrich each task spec (default: sonnet; e.g. opus, haiku)",
  )
  .option(
    "--critic-max-retries <n>",
    "Max critic→re-enrich retries per task (default: 1)",
    parseFloat,
  )
  .option(
    "--re-critic",
    "Read-only audit: run the critic over existing enriched task specs without rewriting them. Requires --from-plan.",
  )
  .option("--run-plan", "Automatically execute the plan after generation")
  .action(
    async (
      prompt: string | undefined,
      opts: {
        fromPlan?: string;
        stopAfter?: string;
        enrichmentCritic?: boolean;
        enrichmentModel?: string;
        criticMaxRetries?: number;
        reCritic?: boolean;
        runPlan?: boolean;
      },
      cmd: Command,
    ) => {
      if (cmd.optsWithGlobals().debug) enableDebug();

      if (opts.stopAfter && opts.stopAfter !== "plan" && opts.stopAfter !== "tasks") {
        console.error("--stop-after must be 'plan' or 'tasks'");
        process.exit(1);
      }

      if (prompt && opts.fromPlan) {
        console.error("Provide either a prompt or --from-plan, not both");
        process.exit(1);
      }
      if (!prompt && !opts.fromPlan) {
        console.error("Provide a prompt or --from-plan <path>");
        process.exit(1);
      }
      if (opts.reCritic && !opts.fromPlan) {
        console.error("--re-critic requires --from-plan");
        process.exit(1);
      }
      if (
        opts.criticMaxRetries !== undefined &&
        (!Number.isInteger(opts.criticMaxRetries) || opts.criticMaxRetries < 0)
      ) {
        console.error("--critic-max-retries must be a non-negative integer");
        process.exit(1);
      }

      let targetRepoRoot: string;
      try {
        targetRepoRoot = await resolveTargetRepoRoot(process.cwd());
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(1);
      }

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const runDir = resolve(harnessRoot, "runs", `plan-${ts}`);
      const logFile = await setupLogging(runDir);
      log.info(`Logging to ${logFile}`);

      const result = await runPlan({
        prompt,
        planPath: opts.fromPlan ? resolve(targetRepoRoot, opts.fromPlan) : undefined,
        stopAfter: opts.stopAfter as "plan" | "tasks" | undefined,
        targetRepoRoot,
        ...(opts.enrichmentModel ? { enrichmentModel: opts.enrichmentModel } : {}),
        enrichmentCritic: opts.enrichmentCritic
          ? {
              enabled: true,
              ...(opts.criticMaxRetries !== undefined ? { maxRetries: opts.criticMaxRetries } : {}),
            }
          : undefined,
        reCritic: opts.reCritic ?? false,
      });

      if (!result.success) {
        process.exit(1);
      }

      if (opts.runPlan && result.planPath) {
        const { runPlanExecution } = await import("./run-plan.js");
        const ok = await runPlanExecution(result.planPath, { targetRepoRoot, harnessRoot });
        process.exit(ok ? 0 : 1);
      }

      process.exit(0);
    },
  );

// ── run-plan ────────────────────────────────────────────────────
program
  .command("run-plan")
  .description("Execute tasks from a plan file sequentially")
  .argument("<plan-path>", "Path to plan YAML file")
  .option("--push", "Push the branch after all tasks complete")
  .action(async (planPath: string, opts: { push?: boolean }, cmd: Command) => {
    if (cmd.optsWithGlobals().debug) enableDebug();

    let targetRepoRoot: string;
    try {
      targetRepoRoot = await resolveTargetRepoRoot(process.cwd());
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }

    const resolvedPlanPath = resolveTaskFilePath(planPath, targetRepoRoot);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = resolve(harnessRoot, "runs", `run-plan-${ts}`);
    const logFile = await setupLogging(runDir);
    log.info(`Logging to ${logFile}`);

    const { runPlanExecution } = await import("./run-plan.js");
    const ok = await runPlanExecution(resolvedPlanPath, {
      targetRepoRoot,
      harnessRoot,
      push: opts.push,
    });
    process.exit(ok ? 0 : 1);
  });

// ── clean ────────────────────────────────────────────────────────
program
  .command("clean")
  .description("Clean up athanor worktrees and branches")
  .option("--all", "Remove all athanor worktrees")
  .option("--older-than <hours>", "Remove worktrees older than N hours", parseFloat)
  .option("--dry-run", "Show what would be removed without removing")
  .action(async (opts: { all?: boolean; olderThan?: number; dryRun?: boolean }, cmd: Command) => {
    if (cmd.optsWithGlobals().debug) enableDebug();

    let targetRepoRoot: string;
    try {
      targetRepoRoot = await resolveTargetRepoRoot(process.cwd());
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }

    const cleanOpts: CleanOpts = {
      all: opts.all ?? false,
      olderThanHours: opts.olderThan ?? null,
      dryRun: opts.dryRun ?? false,
    };
    await cleanWorktrees(cleanOpts, targetRepoRoot);
    process.exit(0);
  });

// ── init ─────────────────────────────────────────────────────────
program
  .command("init")
  .description("Scaffold .athanor/ directory in the current repo")
  .action(async () => {
    const { runInit } = await import("./init.js");
    await runInit();
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
