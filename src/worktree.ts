import { execa } from "execa";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class Worktree {
  readonly targetRepoRoot: string;
  readonly harnessRoot: string;
  readonly taskId: string;
  readonly runId: string;
  readonly branch: string;
  readonly path: string; // absolute path to the worktree root

  private readonly baseBranch?: string;

  constructor(
    targetRepoRoot: string,
    harnessRoot: string,
    taskId: string,
    runId: string,
    baseBranch?: string,
  ) {
    this.targetRepoRoot = resolve(targetRepoRoot);
    this.harnessRoot = resolve(harnessRoot);
    this.taskId = taskId;
    this.runId = runId;
    this.baseBranch = baseBranch;
    this.branch = `athanor/${taskId}/${runId}`;
    // Worktrees live at the harness root under .worktrees/.
    this.path = resolve(this.harnessRoot, `.worktrees/${taskId}-${runId}`);
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const result = await execa("git", args, {
      cwd: cwd ?? this.targetRepoRoot,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode})\n${result.stderr}`);
    }
    return result.stdout;
  }

  async create(): Promise<string> {
    await mkdir(dirname(this.path), { recursive: true });

    const startPoint = this.baseBranch ?? (await this.detectDefaultBranch());

    // Fetch the latest branch from origin (best-effort).
    // When baseBranch is an athanor task branch it won't exist on origin, so
    // fetch is expected to fail — that's fine.
    try {
      await this.git(["fetch", "origin", startPoint]);
    } catch {
      // No remote or fetch failed — local-only is fine.
    }

    // Prefer the local branch so unpushed commits are included.
    // Fall back to origin's copy when the local branch doesn't exist.
    try {
      await this.git(["worktree", "add", "-b", this.branch, this.path, startPoint]);
    } catch {
      await this.git(["worktree", "add", "-b", this.branch, this.path, `origin/${startPoint}`]);
    }

    return this.path;
  }

  /**
   * Detect the default branch name for the target repo.
   * Checks the origin remote HEAD first, then falls back to
   * well-known names (main, master), and finally the current branch.
   */
  private async detectDefaultBranch(): Promise<string> {
    // Ask git which branch origin/HEAD points to (e.g. "origin/main").
    try {
      const symref = await this.git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      const branch = symref.trim().replace("refs/remotes/origin/", "");
      if (branch) return branch;
    } catch {
      // origin/HEAD not set — fall through.
    }

    // Check for common default branch names locally.
    for (const candidate of ["main", "master"]) {
      try {
        await this.git(["rev-parse", "--verify", candidate]);
        return candidate;
      } catch {
        // doesn't exist — try next.
      }
    }

    // Last resort: use whatever branch is currently checked out.
    const current = await this.git(["branch", "--show-current"]);
    return current.trim();
  }

  async commitAll(message: string): Promise<void> {
    await this.git(["add", "-A"], this.path);
    try {
      await this.git(["commit", "-m", message], this.path);
    } catch (err) {
      // "nothing to commit" exits 1 — that's fine if the agent already committed.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("nothing to commit")) {
        return;
      }
      throw err;
    }
  }

  async push(): Promise<void> {
    await this.git(["push", "-u", "origin", this.branch], this.path);
  }

  async destroy(): Promise<void> {
    await this.git(["worktree", "remove", "--force", this.path]);
    // Keep the branch around so you can inspect failed runs.
  }

  /**
   * All files changed in the worktree, returned as paths relative to the
   * worktree root (so they can be matched against allowedPaths globs from
   * the task spec).
   */
  async changedFiles(): Promise<string[]> {
    const out = await this.git(["status", "--porcelain", "-uall"], this.path);
    return parseChangedFiles(out);
  }

  /**
   * Unified diff of all changes in the worktree (staged + unstaged)
   * relative to HEAD.
   */
  async diff(): Promise<string> {
    return this.git(["diff", "HEAD"], this.path);
  }
}

export function parseChangedPathsFromPorcelainLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  const payload = line.slice(3).trim();
  if (!payload) {
    return [];
  }

  if (!payload.includes(" -> ")) {
    return [payload];
  }

  return payload
    .split(" -> ")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseChangedFiles(status: string): string[] {
  const changed = new Set<string>();

  for (const line of status.split("\n")) {
    for (const path of parseChangedPathsFromPorcelainLine(line)) {
      changed.add(path);
    }
  }

  return [...changed];
}

export function makeRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`
  );
}
