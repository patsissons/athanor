import { parse } from "yaml";
import { EvalResultSchema, type EvalResult, type EvaluatorConfig } from "./eval-spec.js";
import type { TaskSpec } from "./task-spec.js";
import { buildEvaluatorPrompt, buildInteractiveEvaluatorPrompt } from "./evaluator-prompt.js";
import { extractYaml } from "./yaml-extract.js";
import type { AgentResult, McpConfig } from "./agent.js";
import { startDevServer, type DevServerHandle } from "./dev-server.js";

export interface EvaluatorDeps {
  invokeAgent(opts: {
    prompt: string;
    cwd: string;
    model: string;
    mcpConfig?: McpConfig;
  }): Promise<AgentResult>;
  startDevServer?: typeof startDevServer;
}

export async function runEvaluator(opts: {
  task: TaskSpec;
  diff: string;
  evaluator: EvaluatorConfig;
  cwd: string;
  deps: EvaluatorDeps;
}): Promise<EvalResult> {
  const { evaluator } = opts;

  if (evaluator.mode === "interactive" && evaluator.devServer) {
    return runInteractiveEvaluator(opts);
  }

  return runDiffReviewEvaluator(opts);
}

async function runDiffReviewEvaluator(opts: {
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

  return parseEvalResult(result);
}

async function runInteractiveEvaluator(opts: {
  task: TaskSpec;
  diff: string;
  evaluator: EvaluatorConfig;
  cwd: string;
  deps: EvaluatorDeps;
}): Promise<EvalResult> {
  const { task, diff, evaluator, cwd, deps } = opts;
  const devServerConfig = evaluator.devServer!;
  const start = deps.startDevServer ?? startDevServer;

  let server: DevServerHandle;
  try {
    server = await start(devServerConfig, cwd);
  } catch (err) {
    return {
      passed: false,
      issues: [],
      summary: `Failed to start dev server: ${String(err)}`,
    };
  }

  try {
    const prompt = buildInteractiveEvaluatorPrompt({
      task,
      diff,
      evaluator,
      appUrl: server.url,
    });

    const mcpConfig: McpConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless"],
        },
      },
    };

    const result = await deps.invokeAgent({
      prompt,
      cwd,
      model: evaluator.model,
      mcpConfig,
    });

    return parseEvalResult(result);
  } finally {
    await server.stop();
  }
}

function parseEvalResult(result: { success: boolean; stdout: string; stderr: string }): EvalResult {
  if (!result.success) {
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
