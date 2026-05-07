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

/**
 * Pure builder for the `claude` CLI argument array.
 *
 * `--dangerously-skip-permissions` is hardcoded here. Per the AGENTS.md
 * invariant, the flag is never surfaced as a parameter, config option,
 * or environment variable; it is part of the contract that calling
 * runClaudeCli always means "run inside a disposable isolation."
 */
export function buildClaudeArgs(opts: {
  prompt: string;
  model: string;
  mcpConfigPath?: string;
}): string[] {
  const { prompt, model, mcpConfigPath } = opts;
  return [
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
}

/**
 * Result shape returned by the injected `exec` adapter.
 * exitCode may be null when the child was signal-killed or otherwise
 * terminated without a numeric exit; runClaudeCli treats anything
 * other than 0 (including null) as failure.
 */
export interface ClaudeExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ClaudeExecOpts {
  /** Called for each line of stdout as it streams in. Required for
   *  stream-json parsing — without it, runClaudeCli's AgentResult will
   *  have no parsed fields. */
  stdoutLine?: (line: string) => void;
  /** When true, the child's stdin is closed. */
  stdinIgnore?: true;
  timeoutMs: number;
}

export type ClaudeExec = (
  command: string,
  args: string[],
  opts: ClaudeExecOpts,
) => Promise<ClaudeExecResult>;

/**
 * Run the `claude` CLI through an injected `exec` adapter and
 * aggregate its stream-json output into an AgentResult.
 *
 * `mcpConfigPath` is treated as read-only — runClaudeCli does NOT
 * write or unlink the file at that path. Tempfile creation and
 * cleanup are owned exclusively by callers (today: invokeClaudeCode;
 * later: each isolation backend's runAgent).
 */
export async function runClaudeCli(opts: {
  args: string[];
  exec: ClaudeExec;
  timeoutSeconds?: number;
}): Promise<AgentResult> {
  const { args, exec, timeoutSeconds = 600 } = opts;

  let resultText: string | undefined;

  const result = await exec("claude", args, {
    timeoutMs: timeoutSeconds * 1000,
    stdinIgnore: true,
    stdoutLine: (line) => {
      const collected = prettyPrintEvent(line);
      if (collected) {
        resultText = collected.resultText;
      }
    },
  });

  const summary = extractSummary(resultText);

  return {
    success: result.exitCode === 0,
    stdout: resultText ?? result.stdout,
    stderr: result.stderr,
    parsed: resultText ? { result: resultText } : null,
    summary,
  };
}

/**
 * Default execa-backed exec adapter. Used by invokeClaudeCode for the
 * host-cwd path; isolation backends supply their own adapter (e.g.
 * SandcastleBackend wraps sandcastle.exec).
 */
export function execaClaudeExec(cwd: string): ClaudeExec {
  return async (command, args, opts) => {
    const child = execa(command, args, {
      cwd,
      reject: false,
      timeout: opts.timeoutMs,
      buffer: true,
      stdin: opts.stdinIgnore ? "ignore" : "inherit",
    });

    if (opts.stdoutLine && child.stdout) {
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          opts.stdoutLine!(line);
        }
      });
    }

    const result = await child;
    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}

export async function invokeClaudeCode(opts: {
  prompt: string;
  cwd: string;
  model: string;
  timeoutSeconds?: number;
  mcpConfig?: McpConfig;
}): Promise<AgentResult> {
  const { prompt, cwd, model, timeoutSeconds, mcpConfig } = opts;

  let mcpConfigPath: string | undefined;
  if (mcpConfig) {
    mcpConfigPath = join(
      tmpdir(),
      `athanor-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
    );
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), "utf8");
  }

  try {
    const args = buildClaudeArgs({ prompt, model, mcpConfigPath });
    return await runClaudeCli({ args, exec: execaClaudeExec(cwd), timeoutSeconds });
  } finally {
    if (mcpConfigPath) {
      try {
        await unlink(mcpConfigPath);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

export function extractSummary(resultText: string | undefined): string | undefined {
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
export function prettyPrintEvent(line: string): CollectedResult | undefined {
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

export function summarizeToolInput(name: string, input: unknown): string {
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
