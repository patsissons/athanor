import { describe, expect, it } from "vitest";
import { evaluatePathPolicy } from "./path-policy.js";

describe("evaluatePathPolicy", () => {
  it("passes when there are no changed files", () => {
    expect(evaluatePathPolicy([], ["src/**"], ["package.json"])).toEqual({
      ok: true,
      outOfScope: [],
      forbiddenHits: [],
      retryReason: null,
      message: null,
    });
  });

  it("passes when all changes are within allowed paths and outside forbidden paths", () => {
    const result = evaluatePathPolicy(
      ["src/routes/page.tsx", "src/components/table.tsx"],
      ["src/**"],
      ["package.json"],
    );

    expect(result.ok).toBe(true);
    expect(result.outOfScope).toEqual([]);
    expect(result.forbiddenHits).toEqual([]);
  });

  it("flags out-of-scope changes", () => {
    const result = evaluatePathPolicy(["src/routes/page.tsx", "README.md"], ["src/**"], []);

    expect(result.ok).toBe(false);
    expect(result.outOfScope).toEqual(["README.md"]);
    expect(result.retryReason).toBe("allowedPaths");
    expect(result.message).toContain("outside allowedPaths");
  });

  it("flags forbidden changes", () => {
    const result = evaluatePathPolicy(
      ["src/routes/page.tsx", "package.json"],
      ["src/**", "package.json"],
      ["package.json", "package-lock.json"],
    );

    expect(result.ok).toBe(false);
    expect(result.forbiddenHits).toEqual(["package.json"]);
    expect(result.retryReason).toBe("forbiddenPaths");
    expect(result.message).toContain("modified forbidden files");
  });

  it("reports both out-of-scope and forbidden changes together", () => {
    const result = evaluatePathPolicy(
      ["src/routes/page.tsx", "package-lock.json", "scripts/debug.ts"],
      ["src/**"],
      ["package.json", "package-lock.json"],
    );

    expect(result.ok).toBe(false);
    expect(result.outOfScope).toEqual(["package-lock.json", "scripts/debug.ts"]);
    expect(result.forbiddenHits).toEqual(["package-lock.json"]);
    expect(result.message).toContain("outside allowedPaths");
    expect(result.message).toContain("modified forbidden files");
  });

  it("supports nested glob matches", () => {
    const result = evaluatePathPolicy(
      ["src/app/demo/page.tsx", "src/app/demo/loading.tsx"],
      ["src/app/demo/**"],
      [],
    );

    expect(result.ok).toBe(true);
  });
});
