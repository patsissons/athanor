import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { runTask } from "./orchestrator.js";
import { TaskSpecSchema } from "./task-spec.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd });
  return result.stdout.trim();
}

async function initRepo(): Promise<{
  repoRoot: string;
  harnessRoot: string;
  cleanup: () => Promise<void>;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), "harness-target-"));
  const harnessRoot = await mkdtemp(join(tmpdir(), "harness-root-"));

  await writeFile(join(repoRoot, ".gitignore"), "node_modules/\n");
  await writeFile(
    join(repoRoot, "package.json"),
    JSON.stringify(
      {
        name: "target-app",
        private: true,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(repoRoot, "src.ts"), "export const ready = true;\n");

  await execa("git", ["init", "-b", "main"], { cwd: repoRoot });
  await execa("git", ["config", "user.name", "E2E Test"], { cwd: repoRoot });
  await execa("git", ["config", "user.email", "e2e@example.com"], { cwd: repoRoot });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  await execa("git", ["add", "."], { cwd: repoRoot });
  await execa("git", ["commit", "-m", "init"], { cwd: repoRoot });

  return {
    repoRoot,
    harnessRoot,
    cleanup: async () => {
      // Clean up worktrees before removing the directories
      try {
        await execa("git", ["worktree", "prune"], { cwd: repoRoot });
      } catch {
        // ignore
      }
      await rm(repoRoot, { recursive: true, force: true });
      await rm(harnessRoot, { recursive: true, force: true });
    },
  };
}

function createTask(input: {
  id: string;
  title: string;
  description: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  maxAgentAttempts?: number;
}) {
  return TaskSpecSchema.parse({
    ...input,
    acceptanceCriteria: ["Harness behaves correctly"],
    gates: [{ name: "typecheck", command: "npm run typecheck", maxOutputChars: 200 }],
    maxAgentAttempts: input.maxAgentAttempts ?? 1,
    model: "sonnet",
  });
}

function makeRunId(): string {
  return `20260423-120000-${randomUUID().slice(0, 4)}`;
}

function branchName(taskId: string, runId: string): string {
  return `athanor/${taskId}/${runId}`;
}

function getWorktreePath(harnessRoot: string, taskId: string, runId: string): string {
  return join(harnessRoot, ".worktrees", `${taskId}-${runId}`);
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const output = await git(repoRoot, ["branch", "--list", branch]);
  return output.length > 0;
}

async function commitsAheadOfMain(repoRoot: string, branch: string): Promise<number> {
  return Number(await git(repoRoot, ["rev-list", "--count", `main..${branch}`]));
}

async function readRepoFile(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

async function readWorktreeFile(worktreePath: string, relativePath: string): Promise<string> {
  return readFile(join(worktreePath, relativePath), "utf8");
}

describe.concurrent("runTask e2e", () => {
  it("rejects forbidden file modifications and preserves the failing worktree state", async () => {
    const { repoRoot, harnessRoot, cleanup } = await initRepo();
    try {
      const runId = makeRunId();
      const warnings: string[] = [];
      const task = createTask({
        id: "forbidden-smoke",
        title: "Forbidden smoke test",
        description: "Modify a forbidden file.",
        allowedPaths: ["src/**", "package.json"],
        forbiddenPaths: ["package.json"],
      });
      const branch = branchName(task.id, runId);
      const worktreePath = getWorktreePath(harnessRoot, task.id, runId);

      const ok = await runTask(
        task,
        { targetRepoRoot: repoRoot, harnessRoot },
        {
          invokeAgent: async ({ cwd }) => {
            await writeFile(join(cwd, "package.json"), '{ "name": "mutated" }\n');
            return { success: true, stderr: "" };
          },
          runAllGates: async () => [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
          log: {
            info: () => {},
            warn: (message) => warnings.push(message),
            error: () => {},
            debug: () => {},
          },
          makeRunId: () => runId,
        },
      );

      expect(ok).toBe(false);
      expect(warnings.some((message) => message.includes("Agent modified forbidden files"))).toBe(
        true,
      );
      expect(await branchExists(repoRoot, branch)).toBe(true);
      expect(await commitsAheadOfMain(repoRoot, branch)).toBe(0);
      await expect(stat(worktreePath)).resolves.toBeTruthy();
      expect(await git(worktreePath, ["status", "--short"])).toContain("M package.json");
      expect(await readWorktreeFile(worktreePath, "package.json")).toContain('"name": "mutated"');
      expect(await readRepoFile(repoRoot, "package.json")).toContain('"name": "target-app"');
      expect(await git(repoRoot, ["status", "--short"])).toBe("");
    } finally {
      await cleanup();
    }
  });

  it("commits allowed changes and leaves the successful worktree clean", async () => {
    const { repoRoot, harnessRoot, cleanup } = await initRepo();
    try {
      const runId = makeRunId();
      const warnings: string[] = [];
      const task = createTask({
        id: "success-smoke",
        title: "Success smoke test",
        description: "Modify an allowed file.",
        allowedPaths: ["src.ts"],
        forbiddenPaths: ["package.json"],
      });
      const branch = branchName(task.id, runId);
      const worktreePath = getWorktreePath(harnessRoot, task.id, runId);

      const ok = await runTask(
        task,
        { targetRepoRoot: repoRoot, harnessRoot },
        {
          invokeAgent: async ({ cwd }) => {
            await writeFile(join(cwd, "src.ts"), "export const ready = false;\n");
            return { success: true, stderr: "" };
          },
          runAllGates: async () => [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
          log: {
            info: () => {},
            warn: (message) => warnings.push(message),
            error: () => {},
            debug: () => {},
          },
          makeRunId: () => runId,
        },
      );

      expect(ok).toBe(true);
      expect(await branchExists(repoRoot, branch)).toBe(true);
      expect(await commitsAheadOfMain(repoRoot, branch)).toBe(1);
      expect(await git(worktreePath, ["status", "--short"])).toBe("");
      expect(await readWorktreeFile(worktreePath, "src.ts")).toBe("export const ready = false;\n");
      expect(await readRepoFile(repoRoot, "src.ts")).toBe("export const ready = true;\n");
      expect(await git(repoRoot, ["status", "--short"])).toBe("");
      expect(warnings.some((message) => message.includes("Push failed"))).toBe(true);
      expect(await git(repoRoot, ["log", "-1", "--pretty=%s", branch])).toBe("Success smoke test");
    } finally {
      await cleanup();
    }
  });

  it("rejects out-of-scope changes without creating a commit", async () => {
    const { repoRoot, harnessRoot, cleanup } = await initRepo();
    try {
      const runId = makeRunId();
      const warnings: string[] = [];
      const task = createTask({
        id: "scope-smoke",
        title: "Scope smoke test",
        description: "Modify a file outside allowed paths.",
        allowedPaths: ["src.ts"],
        forbiddenPaths: ["package.json"],
      });
      const branch = branchName(task.id, runId);
      const worktreePath = getWorktreePath(harnessRoot, task.id, runId);

      const ok = await runTask(
        task,
        { targetRepoRoot: repoRoot, harnessRoot },
        {
          invokeAgent: async ({ cwd }) => {
            await writeFile(join(cwd, "extra.ts"), "export const outside = true;\n");
            return { success: true, stderr: "" };
          },
          runAllGates: async () => [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
          log: {
            info: () => {},
            warn: (message) => warnings.push(message),
            error: () => {},
            debug: () => {},
          },
          makeRunId: () => runId,
        },
      );

      expect(ok).toBe(false);
      expect(warnings.some((message) => message.includes("outside allowedPaths"))).toBe(true);
      expect(await commitsAheadOfMain(repoRoot, branch)).toBe(0);
      expect(await git(worktreePath, ["status", "--short"])).toContain("?? extra.ts");
      expect(await git(repoRoot, ["status", "--short"])).toBe("");
    } finally {
      await cleanup();
    }
  });

  it("retries after a gate failure and commits only the final passing state", async () => {
    const { repoRoot, harnessRoot, cleanup } = await initRepo();
    try {
      const runId = makeRunId();
      const warnings: string[] = [];
      const task = createTask({
        id: "retry-smoke",
        title: "Retry smoke test",
        description: "Fix a failing gate on retry.",
        allowedPaths: ["src.ts"],
        forbiddenPaths: ["package.json"],
        maxAgentAttempts: 2,
      });
      const branch = branchName(task.id, runId);
      const worktreePath = getWorktreePath(harnessRoot, task.id, runId);
      let attempt = 0;

      const ok = await runTask(
        task,
        { targetRepoRoot: repoRoot, harnessRoot },
        {
          invokeAgent: async ({ cwd }) => {
            attempt += 1;
            const value = attempt === 1 ? "first" : "second";
            await writeFile(join(cwd, "src.ts"), `export const ready = "${value}";\n`);
            return { success: true, stderr: "" };
          },
          runAllGates: async () => {
            if (attempt === 1) {
              return [
                { name: "typecheck", passed: false, exitCode: 1, output: "first attempt failed" },
              ];
            }

            return [{ name: "typecheck", passed: true, exitCode: 0, output: "" }];
          },
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
          log: {
            info: () => {},
            warn: (message) => warnings.push(message),
            error: () => {},
            debug: () => {},
          },
          makeRunId: () => runId,
        },
      );

      expect(ok).toBe(true);
      expect(attempt).toBe(2);
      expect(await commitsAheadOfMain(repoRoot, branch)).toBe(1);
      expect(await git(worktreePath, ["status", "--short"])).toBe("");
      expect(await readWorktreeFile(worktreePath, "src.ts")).toBe(
        'export const ready = "second";\n',
      );
      expect(await git(repoRoot, ["status", "--short"])).toBe("");
      expect(warnings.some((message) => message.includes("Push failed"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("writes completed-tasks.md after a successful task", async () => {
    const { repoRoot, harnessRoot, cleanup } = await initRepo();
    try {
      const runId = makeRunId();
      const task = createTask({
        id: "summary-smoke",
        title: "Summary smoke test",
        description: "Verify completed-tasks.md is written.",
        allowedPaths: ["src.ts"],
        forbiddenPaths: ["package.json"],
      });

      const ok = await runTask(
        task,
        { targetRepoRoot: repoRoot, harnessRoot },
        {
          invokeAgent: async ({ cwd }) => {
            await writeFile(join(cwd, "src.ts"), "export const ready = false;\n");
            return { success: true, stderr: "", summary: "Updated ready flag to false." };
          },
          runAllGates: async () => [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
          makeRunId: () => runId,
        },
      );

      expect(ok).toBe(true);
      const summaryContent = await readRepoFile(repoRoot, "tasks/completed-tasks.md");
      expect(summaryContent).toContain("## summary-smoke: Summary smoke test");
      expect(summaryContent).toContain("Updated ready flag to false.");
    } finally {
      await cleanup();
    }
  });

  it("appends to completed-tasks.md when it already exists", async () => {
    const { repoRoot, harnessRoot, cleanup } = await initRepo();
    try {
      const runId = makeRunId();
      const task = createTask({
        id: "append-smoke",
        title: "Append smoke test",
        description: "Verify completed-tasks.md is appended to.",
        allowedPaths: ["src.ts"],
        forbiddenPaths: ["package.json"],
      });

      // Seed an existing tasks directory and summary file.
      await mkdir(join(repoRoot, "tasks"), { recursive: true });
      await writeFile(
        join(repoRoot, "tasks", "completed-tasks.md"),
        "## prior-task: Prior Task\n\nDid something useful.\n",
      );

      const ok = await runTask(
        task,
        { targetRepoRoot: repoRoot, harnessRoot },
        {
          invokeAgent: async ({ cwd }) => {
            await writeFile(join(cwd, "src.ts"), "export const ready = false;\n");
            return { success: true, stderr: "", summary: "Appended a new task summary." };
          },
          runAllGates: async () => [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
          makeRunId: () => runId,
        },
      );

      expect(ok).toBe(true);
      const summaryContent = await readRepoFile(repoRoot, "tasks/completed-tasks.md");
      expect(summaryContent).toContain("## prior-task: Prior Task");
      expect(summaryContent).toContain("## append-smoke: Append smoke test");
      expect(summaryContent).toContain("Appended a new task summary.");
    } finally {
      await cleanup();
    }
  });
});
