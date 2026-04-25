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
import { harnessRoot, resolveTargetRepoRoot } from "./paths.js";
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

    let task = await loadTaskSpec(taskPath, targetRepoRoot);
    const appDefaults = await loadAppDefaults(targetRepoRoot);
    task = mergeAppDevServer(task, appDefaults);
    const runDir = resolve(harnessRoot, "runs", task.id);
    const logFile = await setupLogging(runDir);
    log.info(`Logging to ${logFile}`);
    const ok = await runTask(task, { targetRepoRoot, harnessRoot });
    process.exit(ok ? 0 : 1);
  });

// ── plan ─────────────────────────────────────────────────────────
program
  .command("plan")
  .description("Run the three-phase plan pipeline")
  .argument("[prompt]", "The planning prompt")
  .option("--stop-after <phase>", "Stop after phase (plan or tasks)")
  .option("--from-plan <path>", "Resume from existing plan file")
  .option("--enrichment-critic", "Enable enrichment critic for task specs")
  .action(
    async (
      prompt: string | undefined,
      opts: { stopAfter?: string; fromPlan?: string; enrichmentCritic?: boolean },
      cmd: Command,
    ) => {
      if (cmd.optsWithGlobals().debug) enableDebug();

      if (opts.stopAfter && opts.stopAfter !== "plan" && opts.stopAfter !== "tasks") {
        console.error("--stop-after must be 'plan' or 'tasks'");
        process.exit(1);
      }

      if (!prompt && !opts.fromPlan) {
        console.error("Either a prompt or --from-plan is required");
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

      const ok = await runPlan({
        prompt,
        fromPlan: opts.fromPlan,
        stopAfter: opts.stopAfter as "plan" | "tasks" | undefined,
        targetRepoRoot,
        enrichmentCritic: opts.enrichmentCritic ? { enabled: true } : undefined,
      });
      process.exit(ok ? 0 : 1);
    },
  );

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
  .description("Scaffold tasks/ directory in the current repo")
  .action(async () => {
    const { runInit } = await import("./init.js");
    await runInit();
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
