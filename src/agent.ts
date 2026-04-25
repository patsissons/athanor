import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import chalk from "chalk";
import { log } from "./logger.js";

export interface McpServerConfig {
  command: string;
  args: string[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface AgentResult {
  success: boolean;
  stdout: string;
  stderr: string;
  parsed: unknown;
  summary?: string;
}

export async function invokeClaudeCode(opts: {
  prompt: string;
  cwd: string;
  model: string;
  timeoutSeconds?: number;
  mcpConfig?: McpConfig;
}): Promise<AgentResult> {
  const { prompt, cwd, model, timeoutSeconds = 600, mcpConfig } = opts;

  let mcpConfigPath: string | undefined;
  if (mcpConfig) {
    mcpConfigPath = join(
      tmpdir(),
      `athanor-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
    );
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), "utf8");
  }

  const args = [
    "--print",
    "--model",
    model,
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath, "--strict-mcp-config"] : []),
    prompt,
  ];

  const child = execa("claude", args, {
    cwd,
    reject: false,
    timeout: timeoutSeconds * 1000,
    buffer: true,
  });

  // Collect the result text from the final stream event while printing
  // all events to the console in real time.
  let resultText: string | undefined;

  if (child.stdout) {
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const collected = prettyPrintEvent(line);
        if (collected) {
          resultText = collected.resultText;
        }
      }
    });
  }

  const result = await child;

  // Clean up temp MCP config file
  if (mcpConfigPath) {
    try {
      await unlink(mcpConfigPath);
    } catch {
      // Best-effort cleanup
    }
  }

  const summary = extractSummary(resultText);

  return {
    success: result.exitCode === 0,
    stdout: resultText ?? result.stdout,
    stderr: result.stderr,
    parsed: resultText ? { result: resultText } : null,
    summary,
  };
}

function extractSummary(resultText: string | undefined): string | undefined {
  if (!resultText) return undefined;
  const match = resultText.match(/<task-summary>([\s\S]*?)<\/task-summary>/);
  return match?.[1]?.trim();
}

interface ClaudeEvent {
  type?: string;
  event_type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    content?: {
      type?: string;
      name: string;
      input: unknown;
      text?: string;
      is_error?: boolean;
    }[];
  };
  num_turns?: number;
  duration_ms?: number;
}

interface CollectedResult {
  resultText: string | undefined;
  numTurns: number | undefined;
  durationMs: number | undefined;
}

/**
 * Render a single stream-json event as a human-readable line.
 * Returns the collected result data when a result event is encountered.
 */
function prettyPrintEvent(line: string): CollectedResult | undefined {
  if (!line.trim()) return undefined;

  let evt: ClaudeEvent;
  try {
    evt = JSON.parse(line);
  } catch {
    console.log(chalk.gray(`  [raw] ${line}`));
    log.debug(`[raw] ${line}`);
    return undefined;
  }

  // Top-level event envelopes vary by version. Handle the common cases.
  const type = evt.type ?? evt.event_type;

  if (type === "system" && evt.subtype === "init") {
    console.log(chalk.gray(`  [agent] session ${evt.session_id ?? ""} started`));
    log.debug(`[agent] session ${evt.session_id ?? ""} started`);
    return undefined;
  }

  if (type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "text" && block.text) {
        const firstLine = block.text.split("\n")[0].slice(0, 120);
        console.log(chalk.cyan(`  [claude] ${firstLine}`));
        log.debug(`[claude] ${firstLine}`);
      } else if (block.type === "tool_use") {
        const summary = summarizeToolInput(block.name, block.input);
        console.log(chalk.yellow(`  [tool]   ${block.name} ${summary}`));
        log.debug(`[tool] ${block.name} ${summary}`);
      }
    }
    return undefined;
  }

  if (type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result") {
        const ok = block.is_error ? "error" : "ok";
        console.log(chalk.gray(`  [result] ${block.is_error ? chalk.red(ok) : chalk.green(ok)}`));
        log.debug(`[result] ${ok}`);
      }
    }
    return undefined;
  }

  if (type === "result") {
    const doneMsg = `[agent] done (${evt.num_turns ?? "?"} turns, ${evt.duration_ms ?? "?"}ms)`;
    console.log(chalk.gray(`  ${doneMsg}`));
    log.debug(doneMsg);
    return {
      resultText: evt.result,
      numTurns: evt.num_turns,
      durationMs: evt.duration_ms,
    };
  }

  return undefined;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") return i.file_path;
  if (typeof i.path === "string") return i.path;
  if (typeof i.command === "string") {
    const cmd = i.command.slice(0, 80);
    return cmd + (i.command.length > 80 ? "..." : "");
  }
  if (typeof i.pattern === "string") return `"${i.pattern}"`;
  return "";
}
