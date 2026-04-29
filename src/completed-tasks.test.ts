import { describe, expect, it, vi } from "vitest";
import {
  CompletedTasksFileSchema,
  crossReferenceCompletedTasks,
  formatCompletedTasksContext,
  scanGitForTaskIds,
  type CompletedTask,
  type ScanGitDeps,
} from "./completed-tasks.js";

describe("CompletedTasksFileSchema", () => {
  it("parses valid YAML data", () => {
    const data = CompletedTasksFileSchema.parse({
      tasks: [
        { id: "task-1", title: "First task", commitHash: "abc123", summary: "Did stuff" },
        { id: "task-2" },
      ],
    });
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks[0].title).toBe("First task");
    expect(data.tasks[1].title).toBeUndefined();
  });

  it("defaults to empty tasks array", () => {
    const data = CompletedTasksFileSchema.parse({});
    expect(data.tasks).toEqual([]);
  });

  it("requires id field", () => {
    expect(() => CompletedTasksFileSchema.parse({ tasks: [{ title: "no id" }] })).toThrow();
  });
});

describe("scanGitForTaskIds", () => {
  it("parses commit log for task IDs", async () => {
    const deps: ScanGitDeps = {
      exec: vi.fn(async () => ({
        stdout: [
          "abc123 Task: add-favorites-page — Add favorites page",
          "def456 Task: add-favorites-button — Add favorites button",
        ].join("\n"),
        exitCode: 0,
      })),
    };

    const result = await scanGitForTaskIds("/repo", deps);

    expect(result.get("add-favorites-page")).toBe("abc123");
    expect(result.get("add-favorites-button")).toBe("def456");
  });

  it("returns empty map when no matching commits", async () => {
    const deps: ScanGitDeps = {
      exec: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
    };

    const result = await scanGitForTaskIds("/repo", deps);

    expect(result.size).toBe(0);
  });

  it("returns empty map on git failure", async () => {
    const deps: ScanGitDeps = {
      exec: vi.fn(async () => ({ stdout: "", exitCode: 128 })),
    };

    const result = await scanGitForTaskIds("/repo", deps);

    expect(result.size).toBe(0);
  });
});

describe("crossReferenceCompletedTasks", () => {
  it("returns valid with resume at 0 when no tasks completed", () => {
    const result = crossReferenceCompletedTasks([], new Map(), ["task-1", "task-2", "task-3"]);

    expect(result.valid).toBe(true);
    expect(result.resumeIndex).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid with correct resume index for partial completion", () => {
    const yamlTasks: CompletedTask[] = [
      { id: "task-1", title: "First" },
      { id: "task-2", title: "Second" },
    ];
    const gitTasks = new Map([
      ["task-1", "abc123"],
      ["task-2", "def456"],
    ]);

    const result = crossReferenceCompletedTasks(yamlTasks, gitTasks, [
      "task-1",
      "task-2",
      "task-3",
    ]);

    expect(result.valid).toBe(true);
    expect(result.resumeIndex).toBe(2);
  });

  it("returns all-completed when every task is done", () => {
    const yamlTasks: CompletedTask[] = [{ id: "task-1" }, { id: "task-2" }];
    const gitTasks = new Map([
      ["task-1", "abc"],
      ["task-2", "def"],
    ]);

    const result = crossReferenceCompletedTasks(yamlTasks, gitTasks, ["task-1", "task-2"]);

    expect(result.valid).toBe(true);
    expect(result.resumeIndex).toBe(2);
  });

  it("fails when task in YAML but not git", () => {
    const yamlTasks: CompletedTask[] = [{ id: "task-1" }];
    const gitTasks = new Map<string, string>();

    const result = crossReferenceCompletedTasks(yamlTasks, gitTasks, ["task-1", "task-2"]);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("found in completed-tasks.yaml but no matching commit");
  });

  it("fails when task in git but not YAML", () => {
    const yamlTasks: CompletedTask[] = [];
    const gitTasks = new Map([["task-1", "abc123"]]);

    const result = crossReferenceCompletedTasks(yamlTasks, gitTasks, ["task-1", "task-2"]);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("found in git history but not in completed-tasks.yaml");
  });

  it("reports multiple errors for multiple mismatches", () => {
    const yamlTasks: CompletedTask[] = [{ id: "task-1" }];
    const gitTasks = new Map([["task-2", "abc123"]]);

    const result = crossReferenceCompletedTasks(yamlTasks, gitTasks, [
      "task-1",
      "task-2",
      "task-3",
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe("formatCompletedTasksContext", () => {
  it("formats tasks for prompt injection", () => {
    const tasks: CompletedTask[] = [
      { id: "task-1", title: "First task", summary: "Did stuff" },
      { id: "task-2", title: "Second task", summary: "Did more stuff" },
    ];

    const result = formatCompletedTasksContext(tasks);

    expect(result).toContain("## task-1: First task");
    expect(result).toContain("Did stuff");
    expect(result).toContain("## task-2: Second task");
  });

  it("returns empty string for no tasks", () => {
    expect(formatCompletedTasksContext([])).toBe("");
  });

  it("uses id as title when title is missing", () => {
    const tasks: CompletedTask[] = [{ id: "task-1" }];

    const result = formatCompletedTasksContext(tasks);

    expect(result).toContain("## task-1: task-1");
  });
});

describe("CompletedTasksFileSchema (edge cases)", () => {
  it("rejects an entry with an empty id", () => {
    expect(() => CompletedTasksFileSchema.parse({ tasks: [{ id: "" }] })).toThrow();
  });

  it("accepts arbitrary timestamp strings without parsing them", () => {
    // Timestamps are stored verbatim — validation does not enforce ISO 8601.
    // Future-dated values, malformed strings, and timezones all round-trip
    // unchanged. This is intentional: completed-tasks.yaml is local-only state
    // for the harness, not a structured timeline.
    const data = CompletedTasksFileSchema.parse({
      tasks: [
        { id: "future", timestamp: "2099-12-31T00:00:00.000Z" },
        { id: "messy", timestamp: "yesterday" },
        { id: "no-tz", timestamp: "2026-04-28 14:00" },
      ],
    });

    expect(data.tasks.map((t) => t.timestamp)).toEqual([
      "2099-12-31T00:00:00.000Z",
      "yesterday",
      "2026-04-28 14:00",
    ]);
  });

  it("rejects a timestamp of the wrong type", () => {
    expect(() =>
      CompletedTasksFileSchema.parse({ tasks: [{ id: "x", timestamp: 12345 }] }),
    ).toThrow();
  });
});
