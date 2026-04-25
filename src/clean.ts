import { execa } from "execa";
import { log } from "./logger.js";

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export interface CleanOpts {
  all: boolean;
  olderThanHours: number | null;
  dryRun: boolean;
}

export function parseCleanOpts(args: string[]): CleanOpts {
  const opts: CleanOpts = { all: false, olderThanHours: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--all":
        opts.all = true;
        break;
      case "--older-than":
        opts.olderThanHours = Number(args[++i]);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
    }
  }
  return opts;
}

export function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "") {
      if (current.path) entries.push(current as WorktreeEntry);
      current = {};
    }
  }

  if (current.path) entries.push(current as WorktreeEntry);
  return entries;
}

/**
 * Parse `git worktree list --porcelain` output.
 * Each entry is separated by a blank line and has lines like:
 *   worktree /path/to/wt
 *   HEAD <sha>
 *   branch refs/heads/athanor/task/runid
 */
async function listWorktrees(targetRepoRoot: string): Promise<WorktreeEntry[]> {
  const result = await execa("git", ["worktree", "list", "--porcelain"], {
    cwd: targetRepoRoot,
  });
  return parseWorktreeListPorcelain(result.stdout);
}

/**
 * Extract the timestamp embedded in an athanor branch name.
 * Branch format: athanor/<task-id>/<YYYYMMDD-HHMMSS-xxxx>
 */
export function parseAthanorTimestamp(branch: string): Date | null {
  const match = branch.match(/^athanor\/[^/]+\/(\d{8}-\d{6})-/);
  if (!match) return null;
  const s = match[1];
  // "20260423-151540" -> "2026-04-23T15:15:40"
  const iso =
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` +
    `T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export async function cleanWorktrees(opts: CleanOpts, targetRepoRoot: string): Promise<void> {
  const worktrees = await listWorktrees(targetRepoRoot);
  const athanors = worktrees.filter((w) => w.branch && w.branch.startsWith("athanor/"));

  if (athanors.length === 0) {
    log.info("No athanor worktrees to clean");
    return;
  }

  const now = Date.now();
  const cutoffMs = opts.olderThanHours != null ? opts.olderThanHours * 60 * 60 * 1000 : null;

  const targets: WorktreeEntry[] = [];
  for (const wt of athanors) {
    if (opts.all) {
      targets.push(wt);
      continue;
    }
    if (cutoffMs != null) {
      const ts = parseAthanorTimestamp(wt.branch!);
      if (ts && now - ts.getTime() > cutoffMs) {
        targets.push(wt);
      }
    }
  }

  if (targets.length === 0) {
    log.info(`${athanors.length} athanor worktree(s) exist but none match cleanup criteria`);
    return;
  }

  log.info(
    `${opts.dryRun ? "[DRY RUN] Would remove" : "Removing"} ` + `${targets.length} worktree(s):`,
  );
  for (const wt of targets) {
    log.info(`  ${wt.path} (${wt.branch})`);
  }

  if (opts.dryRun) return;

  for (const wt of targets) {
    try {
      await execa("git", ["worktree", "remove", "--force", wt.path], {
        cwd: targetRepoRoot,
      });
      await execa("git", ["branch", "-D", wt.branch!], {
        cwd: targetRepoRoot,
        reject: false, // branch might already be gone
      });
    } catch (e) {
      log.warn(`Failed to remove ${wt.path}: ${String(e)}`);
    }
  }

  // Prune any stale .git/worktrees metadata
  await execa("git", ["worktree", "prune"], { cwd: targetRepoRoot });

  log.info("Cleanup complete");
}
