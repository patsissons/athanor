import { execa } from "execa";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  execaClaudeExec,
  runClaudeCli,
  type AgentResult,
  type McpConfig,
} from "../agent.js";
import type { IsolationBackend, WorktreeLike } from "./index.js";

/**
 * Default IsolationBackend. All commands and agent invocations run on
 * the host with `cwd: this.wt.path`. Behaviour mirrors what
 * `invokeClaudeCode` and the inline `runSubprocess` helper used to do
 * before the isolation refactor — same tempfile flow, same execa
 * options, same stream-json parsing path.
 */
export class WorktreeBackend implements IsolationBackend {
  constructor(private readonly wt: WorktreeLike) {}

  // ── WorktreeLike passthrough ─────────────────────────────────
  get branch(): string {
    return this.wt.branch;
  }

  get path(): string {
    return this.wt.path;
  }

  create(): Promise<string> {
    return this.wt.create();
  }

  changedFiles(): Promise<string[]> {
    return this.wt.changedFiles();
  }

  diff(): Promise<string> {
    return this.wt.diff();
  }

  commitAll(message: string): Promise<void> {
    return this.wt.commitAll(message);
  }

  push(): Promise<void> {
    return this.wt.push();
  }

  // ── Command / agent execution ───────────────────────────────
  async runCommand(
    cmd: string,
    args: string[],
    opts: { timeoutMs: number; env?: Record<string, string> },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const result = await execa(cmd, args, {
      cwd: this.wt.path,
      reject: false,
      timeout: opts.timeoutMs,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async runAgent(opts: {
    prompt: string;
    model: string;
    timeoutSeconds?: number;
    mcpConfig?: McpConfig;
  }): Promise<AgentResult> {
    let mcpConfigPath: string | undefined;
    if (opts.mcpConfig) {
      mcpConfigPath = join(
        tmpdir(),
        `athanor-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
      );
      await writeFile(mcpConfigPath, JSON.stringify(opts.mcpConfig), "utf8");
    }

    try {
      const args = buildClaudeArgs({
        prompt: opts.prompt,
        model: opts.model,
        mcpConfigPath,
      });
      return await runClaudeCli({
        args,
        exec: execaClaudeExec(this.wt.path),
        timeoutSeconds: opts.timeoutSeconds,
      });
    } finally {
      if (mcpConfigPath) {
        try {
          await unlink(mcpConfigPath);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────
  destroy(): Promise<void> {
    return this.wt.destroy();
  }
}
