import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { PlanSpecSchema, type PlanSpec, loadPlanSpec } from "./plan-spec.js";
import { TaskSpecSchema, type TaskSpec, loadTaskSpec } from "./task-spec.js";
import type { AppSpec } from "./app-spec.js";
import type { EvalResult } from "./eval-spec.js";
import { buildPlanPrompt, buildTaskEnrichmentPrompt } from "./plan-prompt.js";
import { mergeAppDevServer } from "./merge-dev-server.js";
import { loadTaskDefaults, loadAppDefaults } from "./plan-defaults.js";
import { extractYaml } from "./yaml-extract.js";
import { invokeClaudeCode, type AgentResult } from "./agent.js";
import { critiqueTaskSpec } from "./enrichment-critic.js";
import { runTask } from "./orchestrator.js";
import { log as defaultLog } from "./logger.js";
import { harnessRoot as defaultHarnessRoot } from "./paths.js";
import type { RunTaskLogger } from "./orchestrator.js";

export interface PlanDeps {
  invokeAgent(opts: { prompt: string; cwd: string; model: string }): Promise<AgentResult>;
  critiqueTaskSpec(opts: {
    taskSpec: TaskSpec;
    plan: PlanSpec;
    cwd: string;
    model: string;
  }): Promise<EvalResult>;
  loadAppDefaults(targetRepoRoot: string): Promise<Partial<AppSpec>>;
  loadTaskDefaults(targetRepoRoot: string): Promise<Partial<TaskSpec>>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  loadPlanSpec(path: string): Promise<PlanSpec>;
  loadTaskSpec(path: string, targetRepoRoot?: string): Promise<TaskSpec>;
  runTask(task: TaskSpec, opts: { targetRepoRoot: string; harnessRoot: string }): Promise<boolean>;
  log: RunTaskLogger;
  harnessRoot: string;
  targetRepoRoot: string;
}

const defaultDeps: PlanDeps = {
  invokeAgent: invokeClaudeCode,
  critiqueTaskSpec: (opts) =>
    critiqueTaskSpec({ ...opts, deps: { invokeAgent: invokeClaudeCode } }),
  loadAppDefaults,
  loadTaskDefaults,
  writeFile: (path, content) => writeFile(path, content, "utf8"),
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  readdir: (path) => readdir(path),
  loadPlanSpec,
  loadTaskSpec,
  runTask,
  log: defaultLog,
  harnessRoot: defaultHarnessRoot,
  targetRepoRoot: process.cwd(),
};

export async function runPlan(
  opts: {
    prompt?: string;
    fromPlan?: string;
    stopAfter?: "plan" | "tasks";
    targetRepoRoot?: string;
    enrichmentCritic?: { enabled: boolean; model?: string };
  },
  deps: Partial<PlanDeps> = {},
): Promise<boolean> {
  const d: PlanDeps = {
    ...defaultDeps,
    ...(opts.targetRepoRoot !== undefined ? { targetRepoRoot: opts.targetRepoRoot } : {}),
    ...deps,
  };

  const appDefaults = await d.loadAppDefaults(d.targetRepoRoot);

  let plan: PlanSpec;

  // ─── Phase 1: Plan Generation ──────────────────────────────────
  if (opts.fromPlan) {
    d.log.info(`Loading existing plan from ${opts.fromPlan}`);
    plan = await d.loadPlanSpec(opts.fromPlan);
  } else {
    if (!opts.prompt) {
      d.log.error("No prompt provided and no --from-plan specified");
      return false;
    }

    d.log.info("Phase 1: Generating plan with Opus");
    const prompt = buildPlanPrompt(opts.prompt, appDefaults);
    const result = await d.invokeAgent({
      prompt,
      cwd: d.targetRepoRoot,
      model: "opus",
    });

    if (!result.success) {
      d.log.error(`Plan agent invocation failed: ${result.stderr}`);
      return false;
    }

    let yamlText: string;
    try {
      yamlText = extractYaml(result.stdout);
    } catch (err) {
      d.log.error(`Failed to extract YAML from plan agent output: ${String(err)}`);
      d.log.error(`Raw output (first 500 chars): ${result.stdout.slice(0, 500)}`);
      return false;
    }

    try {
      plan = PlanSpecSchema.parse(parse(yamlText));
    } catch (err) {
      d.log.error(`Plan YAML failed validation: ${String(err)}`);
      d.log.error(`Extracted YAML:\n${yamlText}`);
      return false;
    }

    const plansDir = resolve(d.targetRepoRoot, "plans");
    await d.mkdir(plansDir);
    const planPath = resolve(plansDir, `${plan.id}.yaml`);
    await d.writeFile(planPath, stringify(plan));
    d.log.info(`Plan written to ${planPath}`);
    d.log.info(`Plan "${plan.name ?? plan.id}" contains ${plan.tasks.length} task(s)`);
  }

  if (opts.stopAfter === "plan") {
    d.log.info("Stopping after plan generation (--stop-after plan)");
    return true;
  }

  // ─── Phase 2: Task Generation ──────────────────────────────────
  d.log.info("Phase 2: Generating task specs with Sonnet");
  const taskDefaults = await d.loadTaskDefaults(d.targetRepoRoot);
  const tasksDir = resolve(d.targetRepoRoot, "tasks", plan.id);
  await d.mkdir(tasksDir);

  for (const planTask of plan.tasks) {
    d.log.info(`Enriching task: ${planTask.id}`);
    const prompt = buildTaskEnrichmentPrompt({
      app: appDefaults,
      plan,
      targetTaskId: planTask.id,
      taskDefaults,
    });
    const result = await d.invokeAgent({
      prompt,
      cwd: d.targetRepoRoot,
      model: "sonnet",
    });

    if (!result.success) {
      d.log.error(`Task enrichment agent failed for ${planTask.id}: ${result.stderr}`);
      return false;
    }

    let yamlText: string;
    try {
      yamlText = extractYaml(result.stdout);
    } catch (err) {
      d.log.error(`Failed to extract YAML for task ${planTask.id}: ${String(err)}`);
      return false;
    }

    let taskSpec: TaskSpec;
    try {
      taskSpec = TaskSpecSchema.parse(parse(yamlText));
    } catch (err) {
      d.log.error(`Task YAML validation failed for ${planTask.id}: ${String(err)}`);
      d.log.error(`Extracted YAML:\n${yamlText}`);
      return false;
    }

    // ─── Optional: Single-pass enrichment critic ─────────────────
    if (opts.enrichmentCritic?.enabled) {
      const criticModel = opts.enrichmentCritic.model ?? "opus";
      d.log.info(`Running enrichment critic on ${planTask.id} (${criticModel})`);
      const criticResult = await d.critiqueTaskSpec({
        taskSpec,
        plan,
        cwd: d.targetRepoRoot,
        model: criticModel,
      });

      if (!criticResult.passed) {
        d.log.warn(`Critic rejected ${planTask.id}: ${criticResult.summary}`);
        d.log.info(`Re-enriching ${planTask.id} with critic feedback`);

        // Build a new enrichment prompt that includes the critic feedback
        const criticFeedback = [
          "A critic reviewed the initial task spec and found issues:",
          criticResult.summary,
          ...(criticResult.issues ?? []).map(
            (issue) =>
              `  [${issue.severity}] ${issue.criterion}: ${issue.description}` +
              (issue.suggestion ? ` (fix: ${issue.suggestion})` : ""),
          ),
        ].join("\n");

        const retryPrompt = buildTaskEnrichmentPrompt({
          app: appDefaults,
          plan,
          targetTaskId: planTask.id,
          taskDefaults,
          assets: { "Critic Feedback": criticFeedback },
        });

        const retryResult = await d.invokeAgent({
          prompt: retryPrompt,
          cwd: d.targetRepoRoot,
          model: "sonnet",
        });

        if (retryResult.success) {
          try {
            const retryYaml = extractYaml(retryResult.stdout);
            taskSpec = TaskSpecSchema.parse(parse(retryYaml));
            d.log.info(`Re-enrichment succeeded for ${planTask.id}`);
          } catch (err) {
            d.log.warn(
              `Re-enrichment parse failed for ${planTask.id}, using original spec: ${String(err)}`,
            );
          }
        } else {
          d.log.warn(`Re-enrichment agent failed for ${planTask.id}, using original spec`);
        }
      } else {
        d.log.info(`Critic approved ${planTask.id}`);
      }
    }

    const taskPath = resolve(tasksDir, `${planTask.id}.yaml`);
    await d.writeFile(taskPath, stringify(taskSpec));
    d.log.info(`Task written to ${taskPath}`);
  }

  if (opts.stopAfter === "tasks") {
    d.log.info("Stopping after task generation (--stop-after tasks)");
    return true;
  }

  // ─── Phase 3: Task Execution ───────────────────────────────────
  d.log.info("Phase 3: Executing tasks");
  const taskFiles = await d.readdir(tasksDir);
  const yamlFiles = taskFiles.filter((f) => f.endsWith(".yaml")).sort();

  let allPassed = true;
  for (const file of yamlFiles) {
    const taskPath = resolve(tasksDir, file);
    let task = await d.loadTaskSpec(taskPath, d.targetRepoRoot);
    task = mergeAppDevServer(task, appDefaults);
    d.log.info(`Running task: ${task.id}`);
    const ok = await d.runTask(task, {
      targetRepoRoot: d.targetRepoRoot,
      harnessRoot: d.harnessRoot,
    });
    if (ok) {
      d.log.info(`Task ${task.id} completed successfully`);
    } else {
      d.log.error(`Task ${task.id} failed`);
      allPassed = false;
    }
  }

  return allPassed;
}
