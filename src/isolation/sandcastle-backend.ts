import { writeFile, unlink, cp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, isAbsolute, resolve } from "node:path";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import type {
  BindMountSandboxHandle,
  BindMountSandboxProvider,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import {
  buildClaudeArgs,
  runClaudeCli,
  type AgentResult,
  type ClaudeExec,
  type McpConfig,
} from "../agent.js";
import type {
  ContainerLike,
  ContainerExecOpts,
  ContainerExecResult,
  IsolationBackend,
  IsolationConfig,
  WorktreeLike,
} from "./index.js";

/**
 * Configuration shape consumed by SandcastleBackend. Narrowed from the
 * IsolationConfig discriminated union for the "sandcastle" variant.
 */
export type SandcastleConfig = Extract<IsolationConfig, { backend: "sandcastle" }>;

/**
 * Wrap a sandcastle BindMountSandboxHandle so it satisfies the
 * ContainerLike interface athanor's isolation layer consumes. Keeps
 * sandcastle out of every other module.
 */
export function adaptSandcastleSandbox(handle: BindMountSandboxHandle): ContainerLike {
  return {
    async exec(cmd: string, args: string[], opts: ContainerExecOpts): Promise<ContainerExecResult> {
      const shellCommand = formatShellCommand(cmd, args);
      const result = await handle.exec(shellCommand, {
        onLine: opts.stdoutLine,
        // sandcastle's exec accepts a shell-style command string, so
        // formatShellCommand quotes args with shell metacharacters.
      });
      // sandcastle returns ExecResult with a non-nullable exitCode; we
      // widen to `number | null` to match the ContainerLike contract,
      // but in practice sandcastle never produces null here.
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    destroy: () => handle.close(),
  };
}

/**
 * Sandcastle-backed IsolationBackend. Composes a host WorktreeLike
 * (for git operations — bind-mounted into the container so commits
 * made inside the sandbox are visible to host git) and a ContainerLike
 * (sandcastle's bind-mount provider, for command execution).
 *
 * The container is created in `create()` once the host worktree is
 * materialised; `destroy()` tears down the container only and
 * intentionally leaves the worktree for inspection (matching
 * WorktreeBackend's behaviour).
 */
export class SandcastleBackend implements IsolationBackend {
  private container: ContainerLike | undefined;

  constructor(
    private readonly cfg: SandcastleConfig,
    private readonly wt: WorktreeLike,
    private readonly hostRepoPath: string,
  ) {}

  // ── WorktreeLike passthrough ─────────────────────────────────
  get branch(): string {
    return this.wt.branch;
  }

  get path(): string {
    return this.wt.path;
  }

  async create(): Promise<string> {
    await this.wt.create();

    // Apply copyToWorktree by copying files from the host repo root
    // into the worktree BEFORE the sandbox starts. The worktree is
    // bind-mounted, so anything we drop in wt.path is visible inside
    // the container at the same path.
    if (this.cfg.copyToWorktree && this.cfg.copyToWorktree.length > 0) {
      for (const rel of this.cfg.copyToWorktree) {
        const src = isAbsolute(rel) ? rel : resolve(this.hostRepoPath, rel);
        const dest = resolve(this.wt.path, rel);
        await cp(src, dest, { recursive: true, force: true });
      }
    }

    const provider = pickSandcastleProvider(this.cfg);
    const handle = await provider.create({
      worktreePath: this.wt.path,
      hostRepoPath: this.hostRepoPath,
      mounts: [],
      env: {},
    });
    this.container = adaptSandcastleSandbox(handle);

    return this.wt.path;
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
    if (!this.container) {
      throw new Error("SandcastleBackend.runCommand called before create()");
    }
    return this.container.exec(cmd, args, {
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
  }

  async runAgent(opts: {
    prompt: string;
    model: string;
    timeoutSeconds?: number;
    mcpConfig?: McpConfig;
  }): Promise<AgentResult> {
    if (!this.container) {
      throw new Error("SandcastleBackend.runAgent called before create()");
    }

    // The MCP config tempfile MUST live inside the bind-mounted
    // worktree so the in-container CLI can read it. os.tmpdir() on the
    // host is invisible to the container; placing the file at
    // `wt.path/.athanor-mcp-<uuid>.json` puts it on the bind-mount.
    let mcpConfigPath: string | undefined;
    if (opts.mcpConfig) {
      mcpConfigPath = join(this.wt.path, `.athanor-mcp-${randomUUID()}.json`);
      await writeFile(mcpConfigPath, JSON.stringify(opts.mcpConfig), "utf8");
    }

    try {
      const args = buildClaudeArgs({
        prompt: opts.prompt,
        model: opts.model,
        mcpConfigPath,
      });

      const exec: ClaudeExec = async (command, execArgs, execOpts) => {
        const result = await this.container!.exec(command, execArgs, {
          timeoutMs: execOpts.timeoutMs,
          stdoutLine: execOpts.stdoutLine,
          stdinIgnore: execOpts.stdinIgnore,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      };

      return await runClaudeCli({ args, exec, timeoutSeconds: opts.timeoutSeconds });
    } finally {
      if (mcpConfigPath) {
        try {
          await unlink(mcpConfigPath);
        } catch {
          // best-effort cleanup; the agent may have created/removed
          // additional files in wt.path, that's fine.
        }
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────
  async destroy(): Promise<void> {
    // Tear down the container only. The host worktree is preserved
    // for inspection — `athanor clean` is the explicit path for
    // removing it. (Matches WorktreeBackend's no-op destroy.)
    if (this.container) {
      try {
        await this.container.destroy();
      } finally {
        this.container = undefined;
      }
    }
  }
}

function pickSandcastleProvider(cfg: SandcastleConfig): BindMountSandboxProvider {
  const providerName = cfg.provider ?? "docker";
  const opts = cfg.image ? { imageName: cfg.image } : undefined;
  let provider: SandboxProvider;
  switch (providerName) {
    case "docker":
      provider = docker(opts);
      break;
    case "podman":
      provider = podman(opts);
      break;
    default: {
      const _exhaustive: never = providerName;
      void _exhaustive;
      throw new Error(`Unknown sandcastle provider: ${String(providerName)}`);
    }
  }
  if (provider.tag !== "bind-mount") {
    throw new Error(
      `sandcastle ${providerName} provider returned an unexpected non-bind-mount tag`,
    );
  }
  return provider;
}

/**
 * Format `(cmd, args[])` as a shell-style command string for sandcastle.
 * sandcastle's bind-mount handle takes a single string and routes it
 * through a shell, so we quote each arg defensively.
 */
function formatShellCommand(cmd: string, args: string[]): string {
  return [cmd, ...args.map(shellQuote)].join(" ");
}

function shellQuote(s: string): string {
  // Pass through tokens that are obviously safe: alphanumerics, dots,
  // dashes, underscores, slashes, equals.
  if (/^[A-Za-z0-9._\-/=:]+$/.test(s)) {
    return s;
  }
  // Otherwise wrap in single quotes, escaping any embedded single
  // quotes via the standard `'\''` dance.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
