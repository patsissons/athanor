import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { PlanSpecSchema, loadPlanSpec, type PlanSpec } from "./plan-spec.js";
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
    enrichedSiblings?: TaskSpec[];
  }): Promise<EvalResult>;
  loadAppDefaults(targetRepoRoot: string): Promise<Partial<AppSpec>>;
  loadTaskDefaults(targetRepoRoot: string): Promise<Partial<TaskSpec>>;
  loadPlanFile(path: string): Promise<PlanSpec>;
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
  loadPlanFile: loadPlanSpec,
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
    planPath?: string;
    stopAfter?: "plan" | "tasks";
    targetRepoRoot?: string;
    enrichmentCritic?: { enabled: boolean; model?: string; maxRetries?: number };
    reCritic?: boolean;
  },
  deps: Partial<PlanDeps> = {},
): Promise<PlanResult> {
  const d: PlanDeps = {
    ...defaultDeps,
    ...(opts.targetRepoRoot !== undefined ? { targetRepoRoot: opts.targetRepoRoot } : {}),
    ...deps,
  };

  if (opts.prompt && opts.planPath) {
    d.log.error("Provide either a prompt or --from-plan, not both");
    return { success: false };
  }
  if (!opts.prompt && !opts.planPath) {
    d.log.error("No prompt provided");
    return { success: false };
  }
  if (opts.reCritic && !opts.planPath) {
    d.log.error("--re-critic requires --from-plan");
    return { success: false };
  }

  const appDefaults = await d.loadAppDefaults(d.targetRepoRoot);
  const taskDefaults = await d.loadTaskDefaults(d.targetRepoRoot);

  let plan: PlanSpec;
  let planPath: string;

  if (opts.planPath) {
    // ─── Phase 1 (skipped): load existing plan ─────────────────────
    d.log.info(`Loading plan from ${opts.planPath}`);
    try {
      plan = await d.loadPlanFile(opts.planPath);
    } catch (err) {
      d.log.error(`Failed to load plan from ${opts.planPath}: ${String(err)}`);
      return { success: false };
    }
    planPath = opts.planPath;
    d.log.info(`Plan "${plan.name ?? plan.id}" contains ${plan.tasks.length} task(s)`);

    if (opts.stopAfter === "plan") {
      d.log.info("Stopping after plan load (--stop-after plan)");
      return { success: true, planPath };
    }
  } else {
    // ─── Phase 1: Plan Generation ────────────────────────────────
    d.log.info("Phase 1: Generating plan with Opus");
    const prompt = buildPlanPrompt(opts.prompt!, appDefaults, taskDefaults);
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

    try {
      plan = PlanSpecSchema.parse(parse(yamlText));
    } catch (err) {
      d.log.error(`Plan YAML failed validation: ${String(err)}`);
      d.log.error(`Extracted YAML:\n${yamlText}`);
      return { success: false };
    }

    const plansDir = resolve(d.targetRepoRoot, ".athanor", "plans");
    await d.mkdir(plansDir);
    planPath = resolve(plansDir, `${plan.id}.yaml`);
    await d.writeFile(planPath, stringify(plan));
    d.log.info(`Plan written to ${planPath}`);
    d.log.info(`Plan "${plan.name ?? plan.id}" contains ${plan.tasks.length} task(s)`);

    if (opts.stopAfter === "plan") {
      d.log.info("Stopping after plan generation (--stop-after plan)");
      return { success: true, planPath };
    }
  }

  // ─── Audit mode: --re-critic ────────────────────────────────────
  // Read-only pass that runs the critic over already-enriched task
  // specs without rewriting them. Useful after the critic prompt or
  // schema changes, or when iterating on a plan's task descriptions.
  if (opts.reCritic) {
    const tasksDir = resolve(d.targetRepoRoot, ".athanor", "tasks", plan.id);
    const criticModel = opts.enrichmentCritic?.model ?? "opus";

    d.log.info(`Re-critic audit: loading enriched specs from ${tasksDir}`);

    const taskSpecs: TaskSpec[] = [];
    for (const planTask of plan.tasks) {
      const taskPath = resolve(tasksDir, `${planTask.id}.yaml`);
      try {
        const raw = await readFile(taskPath, "utf8");
        taskSpecs.push(TaskSpecSchema.parse(parse(raw)));
      } catch (err) {
        d.log.warn(`Could not load enriched task ${planTask.id}: ${String(err)}`);
      }
    }

    if (taskSpecs.length === 0) {
      d.log.error(
        `No enriched task specs found under ${tasksDir}. Run \`athanor plan --from-plan\` first.`,
      );
      return { success: false };
    }

    let anyRejected = false;
    for (const taskSpec of taskSpecs) {
      const siblings = taskSpecs.filter((t) => t.id !== taskSpec.id);
      d.log.info(`Re-critic on ${taskSpec.id} (${criticModel})`);
      const criticResult = await d.critiqueTaskSpec({
        taskSpec,
        plan,
        cwd: d.targetRepoRoot,
        model: criticModel,
        enrichedSiblings: siblings,
      });

      if (criticResult.passed) {
        d.log.info(`  approved`);
      } else {
        anyRejected = true;
        d.log.warn(`  rejected: ${criticResult.summary}`);
        for (const issue of criticResult.issues ?? []) {
          d.log.warn(`    [${issue.severity}] ${issue.criterion}: ${issue.description}`);
        }
      }
    }

    d.log.info(
      anyRejected
        ? `Re-critic finished with rejections; task files were NOT modified.`
        : `Re-critic finished; all enriched specs approved.`,
    );
    return { success: !anyRejected, planPath };
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

  // Track enriched siblings so the critic can detect cross-task drift in
  // file paths, type names, and signatures. Pre-load any task specs that
  // already exist on disk (resume case) so the first new task enriched
  // in this run still sees prior siblings.
  const enrichedSiblings: TaskSpec[] = [];
  for (const planTask of plan.tasks) {
    if (!existingTaskIds.has(planTask.id)) continue;
    const existingPath = resolve(tasksDir, `${planTask.id}.yaml`);
    try {
      const raw = await readFile(existingPath, "utf8");
      enrichedSiblings.push(TaskSpecSchema.parse(parse(raw)));
    } catch (err) {
      d.log.warn(
        `Could not load existing task ${planTask.id} for cross-task context: ${String(err)}`,
      );
    }
  }

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

    // ─── Optional: enrichment critic with bounded retry loop ─────
    let unresolvedCritic: EvalResult | undefined;
    if (opts.enrichmentCritic?.enabled) {
      const criticModel = opts.enrichmentCritic.model ?? "opus";
      const maxRetries = opts.enrichmentCritic.maxRetries ?? 1;
      let attempt = 0;

      while (true) {
        d.log.info(
          `Running enrichment critic on ${planTask.id} (${criticModel}, attempt ${attempt + 1}/${maxRetries + 1})`,
        );
        const criticResult = await d.critiqueTaskSpec({
          taskSpec,
          plan,
          cwd: d.targetRepoRoot,
          model: criticModel,
          enrichedSiblings,
        });

        if (criticResult.passed) {
          d.log.info(`Critic approved ${planTask.id}`);
          break;
        }

        if (attempt >= maxRetries) {
          unresolvedCritic = criticResult;
          d.log.warn(
            `Critic still rejected ${planTask.id} after ${attempt} re-enrichment(s); using last spec. Last summary: ${criticResult.summary}`,
          );
          break;
        }

        d.log.warn(`Critic rejected ${planTask.id}: ${criticResult.summary}`);
        d.log.info(
          `Re-enriching ${planTask.id} with critic feedback (retry ${attempt + 1}/${maxRetries})`,
        );

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

        if (!retryResult.success) {
          unresolvedCritic = criticResult;
          d.log.warn(`Re-enrichment agent failed for ${planTask.id}, using last accepted spec`);
          break;
        }

        try {
          const retryYaml = extractYaml(retryResult.stdout);
          taskSpec = TaskSpecSchema.parse(parse(retryYaml));
          d.log.info(`Re-enrichment succeeded for ${planTask.id}; re-running critic`);
        } catch (err) {
          unresolvedCritic = criticResult;
          d.log.warn(
            `Re-enrichment parse failed for ${planTask.id}, using last accepted spec: ${String(err)}`,
          );
          break;
        }

        attempt++;
      }
    }

    const taskPath = resolve(tasksDir, `${planTask.id}.yaml`);
    const fileContent = unresolvedCritic
      ? renderUnresolvedCriticHeader(unresolvedCritic) + stringify(taskSpec)
      : stringify(taskSpec);
    await d.writeFile(taskPath, fileContent);
    d.log.info(`Task written to ${taskPath}`);
    enrichedSiblings.push(taskSpec);
  }

  if (opts.stopAfter === "tasks") {
    d.log.info("Stopping after task generation (--stop-after tasks)");
  }

  return { success: true, planPath };
}

/**
 * Build a YAML comment block describing critic concerns that were
 * not resolved before retries were exhausted. Prepended to the task
 * YAML so an implementing agent reading the file sees the open
 * issues — the comments are ignored by the YAML parser, so the spec
 * still loads cleanly.
 */
export function renderUnresolvedCriticHeader(critic: EvalResult): string {
  const lines: string[] = [];
  lines.push("# ── CRITIC OVERRIDDEN ──────────────────────────────────────────");
  lines.push("# This spec was kept after the critic→re-enrich retry budget was");
  lines.push("# exhausted. Address the issues below before sending to a coding agent,");
  lines.push("# or accept them as known limitations.");
  lines.push("#");
  lines.push("# Last critic summary:");
  for (const line of (critic.summary ?? "").split("\n")) {
    lines.push(`#   ${line}`);
  }
  if (critic.issues && critic.issues.length > 0) {
    lines.push("#");
    lines.push("# Unresolved issues:");
    for (const issue of critic.issues) {
      lines.push(`#   [${issue.severity}] ${issue.criterion}`);
      for (const dline of issue.description.split("\n")) {
        lines.push(`#     ${dline}`);
      }
      if (issue.suggestion) {
        for (const sline of issue.suggestion.split("\n")) {
          lines.push(`#     suggestion: ${sline}`);
        }
      }
    }
  }
  lines.push("# ──────────────────────────────────────────────────────────────");
  lines.push("");
  return lines.join("\n");
}
