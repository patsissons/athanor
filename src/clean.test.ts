import { describe, expect, it } from "vitest";
import { parseAthanorTimestamp, parseWorktreeListPorcelain } from "./clean.js";

describe("parseWorktreeListPorcelain", () => {
  it("parses worktree list output", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/task-1",
      "HEAD def456",
      "branch refs/heads/athanor/task/20260423-120000-abcd",
      "",
    ].join("\n");

    expect(parseWorktreeListPorcelain(output)).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.worktrees/task-1", branch: "athanor/task/20260423-120000-abcd" },
    ]);
  });
});

describe("parseAthanorTimestamp", () => {
  it("extracts timestamps from athanor branches", () => {
    const parsed = parseAthanorTimestamp("athanor/task/20260423-151540-abcd");

    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(3);
    expect(parsed?.getDate()).toBe(23);
    expect(parsed?.getHours()).toBe(15);
    expect(parsed?.getMinutes()).toBe(15);
    expect(parsed?.getSeconds()).toBe(40);
  });

  it("returns null for non-athanor branches", () => {
    expect(parseAthanorTimestamp("main")).toBeNull();
  });
});
