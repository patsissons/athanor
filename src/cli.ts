#!/usr/bin/env node
import { resolve } from "node:path";
import { loadTaskSpec } from "./task-spec.js";
import { setupLogging, log, enableDebug } from "./logger.js";
import { runTask } from "./orchestrator.js";
import { cleanWorktrees, parseCleanOpts } from "./clean.js";
import { harnessRoot, resolveTargetRepoRoot } from "./paths.js";
import { runPlan } from "./planner.js";

async function main() {
  const [, , subcommand, ...rest] = process.argv;

  let targetRepoRoot: string;
  try {
    targetRepoRoot = await resolveTargetRepoRoot(process.cwd());
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
    return;
  }

  switch (subcommand) {
    case "run": {
      if (rest.includes("--debug")) enableDebug();
      const taskPath = rest.find((a: string) => !a.startsWith("--"));
      if (!taskPath) {
        console.error("usage: athanor run <path-to-task.yaml> [--debug]");
        process.exit(1);
        return;
      }
      const task = await loadTaskSpec(taskPath, targetRepoRoot);
      const runDir = resolve(harnessRoot, "runs", task.id);
      const logFile = await setupLogging(runDir);
      log.info(`Logging to ${logFile}`);
      const ok = await runTask(task, { targetRepoRoot, harnessRoot });
      process.exit(ok ? 0 : 1);
      return;
    }

    case "plan": {
      if (rest.includes("--debug")) enableDebug();
      const stopAfterIdx = rest.indexOf("--stop-after");
      const stopAfter =
        stopAfterIdx >= 0 ? (rest[stopAfterIdx + 1] as "plan" | "tasks" | undefined) : undefined;
      const fromPlanIdx = rest.indexOf("--from-plan");
      const fromPlan = fromPlanIdx >= 0 ? rest[fromPlanIdx + 1] : undefined;

      if (stopAfter && stopAfter !== "plan" && stopAfter !== "tasks") {
        console.error("--stop-after must be 'plan' or 'tasks'");
        process.exit(1);
        return;
      }

      // Positional arg is the prompt (skip flags and their values)
      const flagValues = new Set<string>();
      if (stopAfterIdx >= 0 && rest[stopAfterIdx + 1]) flagValues.add(rest[stopAfterIdx + 1]);
      if (fromPlanIdx >= 0 && rest[fromPlanIdx + 1]) flagValues.add(rest[fromPlanIdx + 1]);
      const prompt = rest.find((a: string) => !a.startsWith("--") && !flagValues.has(a));

      if (!prompt && !fromPlan) {
        console.error(
          'usage: athanor plan "<prompt>" [--stop-after plan|tasks] [--from-plan <path>] [--debug]',
        );
        process.exit(1);
        return;
      }

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const runDir = resolve(harnessRoot, "runs", `plan-${ts}`);
      const logFile = await setupLogging(runDir);
      log.info(`Logging to ${logFile}`);

      const ok = await runPlan({
        prompt,
        fromPlan,
        stopAfter,
        targetRepoRoot,
      });
      process.exit(ok ? 0 : 1);
      return;
    }

    case "clean": {
      const opts = parseCleanOpts(rest);
      await cleanWorktrees(opts, targetRepoRoot);
      process.exit(0);
      return;
    }

    default:
      console.error("usage:");
      console.error("  athanor run <path-to-task.yaml>");
      console.error(
        '  athanor plan "<prompt>" [--stop-after plan|tasks] [--from-plan <path>] [--debug]',
      );
      console.error("  athanor clean [--all] [--older-than <hours>] [--dry-run]");
      process.exit(1);
      return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
