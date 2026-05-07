import { z } from "zod";
import type { McpConfig, AgentResult } from "../agent.js";
import { Worktree } from "../worktree.js";
import { WorktreeBackend } from "./worktree-backend.js";
import { SandcastleBackend } from "./sandcastle-backend.js";

/**
 * Git-level operations on a worktree. Always satisfied by something
 * that lives on the host filesystem — even when an `IsolationBackend`
 * runs commands inside a container, git operations still go through a
 * host-side worktree (the container bind-mounts it).
 *
 * The existing `Worktree` class in src/worktree.ts is the only
 * production implementation today.
 */
export interface WorktreeLike {
  readonly branch: string;
  readonly path: string;
  create(): Promise<string>;
  changedFiles(): Promise<string[]>;
  diff(): Promise<string>;
  commitAll(message: string): Promise<void>;
  push(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Pure command-execution surface inside an isolated environment.
 * Today, the only implementation is sandcastle's `Sandbox` (wrapped by
 * SandcastleBackend). A future VM/Vercel/etc. backend would supply its
 * own ContainerLike.
 *
 * ContainerLike knows nothing about git — its only responsibility is to
 * run a command and return its captured streams. exitCode is `null` when
 * the underlying primitive cannot report a numeric exit (signal-killed,
 * abrupt termination, etc.).
 */
export interface ContainerExecOpts {
  timeoutMs: number;
  env?: Record<string, string>;
  /** Called for each line of stdout as it streams in. Required for
   *  stream-json parsing inside runClaudeCli to work. */
  stdoutLine?: (line: string) => void;
  /** When true, the child's stdin is closed. */
  stdinIgnore?: true;
}

export interface ContainerExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ContainerLike {
  exec(cmd: string, args: string[], opts: ContainerExecOpts): Promise<ContainerExecResult>;
  destroy(): Promise<void>;
}

/**
 * The unified caller-facing seam. task-loop.ts and orchestrator.ts
 * interact only with this interface; they don't know whether the
 * underlying execution happens on the host or in a container.
 *
 * The git-level surface (branch, path, create, changedFiles, diff,
 * commitAll, push, destroy) is a passthrough to the underlying
 * WorktreeLike. The execution surface (runAgent, runCommand) is what
 * differs between backends — WorktreeBackend uses host execa with
 * cwd=worktree.path, SandcastleBackend routes through a ContainerLike.
 */
export interface IsolationBackend {
  // ── WorktreeLike passthrough ─────────────────────────────────
  readonly branch: string;
  readonly path: string;
  create(): Promise<string>;
  changedFiles(): Promise<string[]>;
  diff(): Promise<string>;
  commitAll(message: string): Promise<void>;
  push(): Promise<void>;

  // ── Command / agent execution ───────────────────────────────
  runCommand(
    cmd: string,
    args: string[],
    opts: { timeoutMs: number; env?: Record<string, string> },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  runAgent(opts: {
    prompt: string;
    model: string;
    timeoutSeconds?: number;
    mcpConfig?: McpConfig;
  }): Promise<AgentResult>;

  // ── Lifecycle ────────────────────────────────────────────────
  /** Tear down both the underlying worktree and any container. */
  destroy(): Promise<void>;
}

// ── Configuration schema ────────────────────────────────────────
//
// Discriminated union on `backend`. Tasks (and plans, plan-task
// overrides, app defaults) opt into a backend by setting an `isolation`
// field that conforms to this schema. The default when no layer is
// supplied is `{ backend: "worktree" }`.

export const IsolationConfigSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("worktree") }),
  z.object({
    backend: z.literal("sandcastle"),
    provider: z.enum(["docker", "podman"]).optional(),
    image: z.string().optional(),
    copyToWorktree: z.array(z.string()).optional(),
  }),
]);

export type IsolationConfig = z.infer<typeof IsolationConfigSchema>;

/**
 * Merge isolation configs from the four spec layers, preferring the
 * most-specific defined value. Layers are inspected in this order:
 * task > planTask > plan > app. If every layer is undefined, returns
 * `{ backend: "worktree" }`.
 */
export function resolveIsolationConfig(layers: {
  app?: IsolationConfig;
  plan?: IsolationConfig;
  planTask?: IsolationConfig;
  task?: IsolationConfig;
}): IsolationConfig {
  return layers.task ?? layers.planTask ?? layers.plan ?? layers.app ?? { backend: "worktree" };
}

// ── Factory ─────────────────────────────────────────────────────
//
// Each concrete backend lands in its own task. Until then both cases
// stub-throw. The `default` branch uses `_exhaustive: never` to fail
// at compile time if a new backend is added without a matching case,
// plus a runtime throw for any backend value that bypasses the type
// system.

export interface IsolationBackendArgs {
  targetRepoRoot: string;
  harnessRoot: string;
  identifier: string;
  runId: string;
  baseBranch?: string;
}

export async function createIsolationBackend(
  cfg: IsolationConfig,
  args: IsolationBackendArgs,
): Promise<IsolationBackend> {
  switch (cfg.backend) {
    case "worktree": {
      const wt = new Worktree(
        args.targetRepoRoot,
        args.harnessRoot,
        args.identifier,
        args.runId,
        args.baseBranch,
      );
      return new WorktreeBackend(wt);
    }
    case "sandcastle": {
      const wt = new Worktree(
        args.targetRepoRoot,
        args.harnessRoot,
        args.identifier,
        args.runId,
        args.baseBranch,
      );
      return new SandcastleBackend(cfg, wt, args.targetRepoRoot);
    }
    default: {
      const _exhaustive: never = cfg;
      void _exhaustive;
      throw new Error(`Unknown isolation backend: ${(cfg as { backend: string }).backend}`);
    }
  }
}
