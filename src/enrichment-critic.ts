import { parse, stringify } from "yaml";
import { EvalResultSchema, type EvalResult } from "./eval-spec.js";
import type { PlanSpec } from "./plan-spec.js";
import type { TaskSpec } from "./task-spec.js";
import { buildEnrichmentCriticPrompt } from "./evaluator-prompt.js";
import { extractYaml } from "./yaml-extract.js";
import type { AgentResult } from "./agent.js";

export interface CriticDeps {
  invokeAgent(opts: { prompt: string; cwd: string; model: string }): Promise<AgentResult>;
}

/**
 * Run a single-pass critic on an enriched task spec.
 * Returns the critic's evaluation result.
 */
export async function critiqueTaskSpec(opts: {
  taskSpec: TaskSpec;
  plan: PlanSpec;
  cwd: string;
  model: string;
  deps: CriticDeps;
}): Promise<EvalResult> {
  const { taskSpec, plan, cwd, model, deps } = opts;

  const siblingTaskIds = plan.tasks.filter((t) => t.id !== taskSpec.id).map((t) => t.id);

  const planContext = [
    plan.name ? `Plan: ${plan.name}` : "",
    plan.description ?? "",
    "",
    "Tasks:",
    ...plan.tasks.map((t) => `- ${t.id}: ${t.description.split("\n")[0]}`),
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = buildEnrichmentCriticPrompt({
    taskYaml: stringify(taskSpec),
    planContext,
    siblingTaskIds,
  });

  const result = await deps.invokeAgent({ prompt, cwd, model });

  if (!result.success) {
    return {
      passed: false,
      issues: [],
      summary: `Critic agent invocation failed: ${result.stderr}`,
    };
  }

  let yamlText: string;
  try {
    yamlText = extractYaml(result.stdout);
  } catch {
    return {
      passed: false,
      issues: [],
      summary: `Critic returned unparseable output. Raw (first 300 chars): ${result.stdout.slice(0, 300)}`,
    };
  }

  try {
    return EvalResultSchema.parse(parse(yamlText));
  } catch (err) {
    return {
      passed: false,
      issues: [],
      summary: `Critic YAML failed validation: ${String(err)}`,
    };
  }
}
