import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execa } from "execa";
import { parse, stringify } from "yaml";
import { z } from "zod";

export const CompletedTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  commitHash: z.string().optional(),
  timestamp: z.string().optional(),
  summary: z.string().optional(),
});

export const CompletedTasksFileSchema = z.object({
  tasks: z.array(CompletedTaskSchema).default([]),
});

export type CompletedTask = z.infer<typeof CompletedTaskSchema>;
export type CompletedTasksFile = z.infer<typeof CompletedTasksFileSchema>;

const COMPLETED_TASKS_PATH = ".athanor/completed-tasks.yaml";

export async function loadCompletedTasks(targetRepoRoot: string): Promise<CompletedTasksFile> {
  const filePath = resolve(targetRepoRoot, COMPLETED_TASKS_PATH);
  try {
    const raw = await readFile(filePath, "utf8");
    return CompletedTasksFileSchema.parse(parse(raw));
  } catch {
    return { tasks: [] };
  }
}

export async function saveCompletedTasks(
  targetRepoRoot: string,
  data: CompletedTasksFile,
): Promise<void> {
  const filePath = resolve(targetRepoRoot, COMPLETED_TASKS_PATH);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, stringify(data), "utf8");
}

export async function appendCompletedTask(
  targetRepoRoot: string,
  entry: CompletedTask,
): Promise<void> {
  const data = await loadCompletedTasks(targetRepoRoot);
  data.tasks.push(entry);
  await saveCompletedTasks(targetRepoRoot, data);
}

export interface ScanGitDeps {
  exec(
    command: string,
    args: string[],
    opts: { cwd: string },
  ): Promise<{ stdout: string; exitCode: number | null }>;
}

const defaultScanDeps: ScanGitDeps = {
  exec: async (command, args, opts) => {
    const result = await execa(command, args, { cwd: opts.cwd, reject: false });
    return { stdout: result.stdout, exitCode: result.exitCode ?? null };
  },
};

/**
 * Scan git history for commits whose messages contain "Task: <id>".
 * Returns a map of taskId -> commitHash.
 */
export async function scanGitForTaskIds(
  cwd: string,
  deps: ScanGitDeps = defaultScanDeps,
): Promise<Map<string, string>> {
  const result = await deps.exec("git", ["log", "--all", "--grep=Task: ", "--format=%H %s"], {
    cwd,
  });

  const taskMap = new Map<string, string>();
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return taskMap;
  }

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;

    const hash = trimmed.slice(0, spaceIdx);
    const subject = trimmed.slice(spaceIdx + 1);

    // Extract task ID from "Task: <id>" pattern in commit subject or body
    const match = subject.match(/Task:\s+(\S+)/);
    if (match) {
      taskMap.set(match[1], hash);
    }
  }

  return taskMap;
}

export interface CrossReferenceResult {
  valid: boolean;
  resumeIndex: number;
  errors: string[];
}

/**
 * Cross-reference completed tasks YAML with git history.
 * Both sources must agree for a task to be considered completed.
 * A mismatch (one but not the other) is a hard failure.
 */
export function crossReferenceCompletedTasks(
  yamlTasks: CompletedTask[],
  gitTasks: Map<string, string>,
  planTaskIds: string[],
): CrossReferenceResult {
  const yamlIds = new Set(yamlTasks.map((t) => t.id));
  const errors: string[] = [];
  let resumeIndex = 0;
  let foundResume = false;

  for (let i = 0; i < planTaskIds.length; i++) {
    const taskId = planTaskIds[i];
    const inYaml = yamlIds.has(taskId);
    const inGit = gitTasks.has(taskId);

    if (inYaml && inGit) {
      if (foundResume) {
        errors.push(
          `Task "${taskId}" appears completed but follows incomplete task "${planTaskIds[resumeIndex]}"`,
        );
      }
      continue;
    }

    if (inYaml && !inGit) {
      errors.push(
        `Task "${taskId}" found in completed-tasks.yaml but no matching commit in git history. ` +
          `Remove it from completed-tasks.yaml or commit the task changes.`,
      );
      continue;
    }

    if (!inYaml && inGit) {
      errors.push(
        `Task "${taskId}" found in git history but not in completed-tasks.yaml. ` +
          `Add it to completed-tasks.yaml with at least the task id.`,
      );
      continue;
    }

    // Neither: this is a potential resume point
    if (!foundResume) {
      resumeIndex = i;
      foundResume = true;
    }
  }

  if (!foundResume) {
    // All tasks completed
    resumeIndex = planTaskIds.length;
  }

  return {
    valid: errors.length === 0,
    resumeIndex,
    errors,
  };
}

/**
 * Format completed tasks for injection into an agent prompt.
 */
export function formatCompletedTasksContext(tasks: CompletedTask[]): string {
  if (tasks.length === 0) return "";

  const lines: string[] = [];
  for (const task of tasks) {
    lines.push(`## ${task.id}: ${task.title ?? task.id}`);
    if (task.summary) {
      lines.push("");
      lines.push(task.summary);
    }
    lines.push("");
  }

  return lines.join("\n");
}
