import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { PlanSpecSchema, type PlanSpec } from "./plan-spec.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";
import type { AppSpec } from "./app-spec.js";
import type { EvalResult } from "./eval-spec.js";
import { buildPlanPrompt, buildTaskEnrichmentPrompt } from "./plan-prompt.js";
import { loadTaskDefaults, loadAppDefaults } from "./plan-defaults.js";
import { extractYaml } from "./yaml-extract.js";
import { invokeClaudeCode, type AgentResult } from "./agent.js";
import { critiqueTaskSpec } from "./enrichment-critic.js";
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
  log: defaultLog,
  harnessRoot: defaultHarnessRoot,
  targetRepoRoot: process.cwd(),
};

export interface PlanResult {
  success: boolean;
  planPath?: string;
}

export async function runPlan(
  opts: {
    prompt?: string;
    stopAfter?: "plan" | "tasks";
    targetRepoRoot?: string;
    enrichmentCritic?: { enabled: boolean; model?: string };
  },
  deps: Partial<PlanDeps> = {},
): Promise<PlanResult> {
  const d: PlanDeps = {
    ...defaultDeps,
    ...(opts.targetRepoRoot !== undefined ? { targetRepoRoot: opts.targetRepoRoot } : {}),
    ...deps,
  };

  const appDefaults = await d.loadAppDefaults(d.targetRepoRoot);
  const taskDefaults = await d.loadTaskDefaults(d.targetRepoRoot);

  // ─── Phase 1: Plan Generation ──────────────────────────────────
  if (!opts.prompt) {
    d.log.error("No prompt provided");
    return { success: false };
  }

  d.log.info("Phase 1: Generating plan with Opus");
  const prompt = buildPlanPrompt(opts.prompt, appDefaults, taskDefaults);
  const result = await d.invokeAgent({
    prompt,
    cwd: d.targetRepoRoot,
    model: "opus",
  });

  if (!result.success) {
    d.log.error(`Plan agent invocation failed: ${result.stderr}`);
    return { success: false };
  }

  let yamlText: string;
  try {
    yamlText = extractYaml(result.stdout);
  } catch (err) {
    d.log.error(`Failed to extract YAML from plan agent output: ${String(err)}`);
    d.log.error(`Raw output (first 500 chars): ${result.stdout.slice(0, 500)}`);
    return { success: false };
  }

  let plan: PlanSpec;
  try {
    plan = PlanSpecSchema.parse(parse(yamlText));
  } catch (err) {
    d.log.error(`Plan YAML failed validation: ${String(err)}`);
    d.log.error(`Extracted YAML:\n${yamlText}`);
    return { success: false };
  }

  const plansDir = resolve(d.targetRepoRoot, ".athanor", "plans");
  await d.mkdir(plansDir);
  const planPath = resolve(plansDir, `${plan.id}.yaml`);
  await d.writeFile(planPath, stringify(plan));
  d.log.info(`Plan written to ${planPath}`);
  d.log.info(`Plan "${plan.name ?? plan.id}" contains ${plan.tasks.length} task(s)`);

  if (opts.stopAfter === "plan") {
    d.log.info("Stopping after plan generation (--stop-after plan)");
    return { success: true, planPath };
  }

  // ─── Phase 2: Task Generation ──────────────────────────────────
  const tasksDir = resolve(d.targetRepoRoot, ".athanor", "tasks", plan.id);

  d.log.info("Phase 2: Generating task specs with Sonnet");
  await d.mkdir(tasksDir);

  // Check which tasks already have YAML files so we can skip them
  let existingFiles: string[] = [];
  try {
    existingFiles = await d.readdir(tasksDir);
  } catch {
    // Directory may not exist yet; treat as empty.
  }
  const existingTaskIds = new Set(
    existingFiles.filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")),
  );

  for (const planTask of plan.tasks) {
    if (existingTaskIds.has(planTask.id)) {
      d.log.info(`Skipping already created task: ${planTask.id}`);
      continue;
    }

    d.log.info(`Enriching task: ${planTask.id}`);
    const enrichPrompt = buildTaskEnrichmentPrompt({
      app: appDefaults,
      plan,
      targetTaskId: planTask.id,
      taskDefaults,
    });
    const enrichResult = await d.invokeAgent({
      prompt: enrichPrompt,
      cwd: d.targetRepoRoot,
      model: "sonnet",
    });

    if (!enrichResult.success) {
      d.log.error(`Task enrichment agent failed for ${planTask.id}: ${enrichResult.stderr}`);
      return { success: false };
    }

    let taskYaml: string;
    try {
      taskYaml = extractYaml(enrichResult.stdout);
    } catch (err) {
      d.log.error(`Failed to extract YAML for task ${planTask.id}: ${String(err)}`);
      return { success: false };
    }

    let taskSpec: TaskSpec;
    try {
      taskSpec = TaskSpecSchema.parse(parse(taskYaml));
    } catch (err) {
      d.log.error(`Task YAML validation failed for ${planTask.id}: ${String(err)}`);
      d.log.error(`Extracted YAML:\n${taskYaml}`);
      return { success: false };
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
  }

  return { success: true, planPath };
}
