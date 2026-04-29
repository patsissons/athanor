import { describe, expect, it } from "vitest";
import { parseChangedFiles, parseChangedPathsFromPorcelainLine } from "./worktree.js";

describe("parseChangedPathsFromPorcelainLine", () => {
  it("parses simple modified entries", () => {
    expect(parseChangedPathsFromPorcelainLine(" M src/page.tsx")).toEqual(["src/page.tsx"]);
  });

  it("parses rename entries into both endpoints", () => {
    expect(parseChangedPathsFromPorcelainLine("R  src/old.ts -> src/new.ts")).toEqual([
      "src/old.ts",
      "src/new.ts",
    ]);
  });

  it("parses untracked entries", () => {
    expect(parseChangedPathsFromPorcelainLine("?? src/new.ts")).toEqual(["src/new.ts"]);
  });

  it("parses untracked directory entries (trailing slash)", () => {
    expect(parseChangedPathsFromPorcelainLine("?? src/components/")).toEqual(["src/components/"]);
  });
});

describe("parseChangedFiles", () => {
  it("returns all changed files", () => {
    const status = [
      " M src/page.tsx",
      "A  src/new.ts",
      "D  src/removed.ts",
      "C  src/source.ts -> src/copy.ts",
      "R  src/old.ts -> src/renamed.ts",
      "?? src/untracked.ts",
    ].join("\n");

    expect(parseChangedFiles(status)).toEqual([
      "src/page.tsx",
      "src/new.ts",
      "src/removed.ts",
      "src/source.ts",
      "src/copy.ts",
      "src/old.ts",
      "src/renamed.ts",
      "src/untracked.ts",
    ]);
  });

  it("deduplicates duplicate paths", () => {
    const status = [" M package.json", "?? package.json"].join("\n");

    expect(parseChangedFiles(status)).toEqual(["package.json"]);
  });

  it("includes all files regardless of directory", () => {
    const status = [" M package.json", "?? docs/guide.md", " M src/page.tsx"].join("\n");

    expect(parseChangedFiles(status)).toEqual(["package.json", "docs/guide.md", "src/page.tsx"]);
  });
});
