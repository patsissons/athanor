import { parse } from "yaml";
import { EvalResultSchema, type EvalResult, type EvaluatorConfig } from "./eval-spec.js";
import type { TaskSpec } from "./task-spec.js";
import { buildEvaluatorPrompt } from "./evaluator-prompt.js";
import { extractYaml } from "./yaml-extract.js";
import type { AgentResult } from "./agent.js";

export interface EvaluatorDeps {
  invokeAgent(opts: { prompt: string; cwd: string; model: string }): Promise<AgentResult>;
}

export async function runEvaluator(opts: {
  task: TaskSpec;
  diff: string;
  evaluator: EvaluatorConfig;
  cwd: string;
  deps: EvaluatorDeps;
}): Promise<EvalResult> {
  const { task, diff, evaluator, cwd, deps } = opts;

  const prompt = buildEvaluatorPrompt({ task, diff, evaluator });
  const result = await deps.invokeAgent({
    prompt,
    cwd,
    model: evaluator.model,
  });

  if (!result.success) {
    // Treat agent failure as a failed evaluation with a descriptive message.
    return {
      passed: false,
      issues: [],
      summary: `Evaluator agent invocation failed: ${result.stderr}`,
    };
  }

  let yamlText: string;
  try {
    yamlText = extractYaml(result.stdout);
  } catch {
    return {
      passed: false,
      issues: [],
      summary: `Evaluator returned unparseable output. Raw (first 300 chars): ${result.stdout.slice(0, 300)}`,
    };
  }

  try {
    return EvalResultSchema.parse(parse(yamlText));
  } catch (err) {
    return {
      passed: false,
      issues: [],
      summary: `Evaluator YAML failed validation: ${String(err)}`,
    };
  }
}

/**
 * Format evaluator feedback for the generator's retry prompt.
 */
export function formatEvalFeedback(evalResult: EvalResult): string {
  const lines: string[] = [];
  lines.push("=== Evaluator Review ===");
  lines.push(evalResult.summary);

  if (evalResult.issues.length > 0) {
    lines.push("");
    lines.push("Issues found:");
    for (const issue of evalResult.issues) {
      lines.push(`  [${issue.severity}] ${issue.criterion}`);
      lines.push(`    ${issue.description}`);
      if (issue.suggestion) {
        lines.push(`    Fix: ${issue.suggestion}`);
      }
    }
  }

  return lines.join("\n");
}
