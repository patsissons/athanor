import { describe, expect, it } from "vitest";
import {
  IsolationConfigSchema,
  resolveIsolationConfig,
  createIsolationBackend,
  type IsolationConfig,
} from "./index.js";

describe("IsolationConfigSchema", () => {
  it("accepts a worktree config", () => {
    expect(() => IsolationConfigSchema.parse({ backend: "worktree" })).not.toThrow();
  });

  it("accepts a sandcastle config with no optional fields", () => {
    expect(() => IsolationConfigSchema.parse({ backend: "sandcastle" })).not.toThrow();
  });

  it("accepts a sandcastle config with all optional fields", () => {
    const cfg = {
      backend: "sandcastle",
      provider: "docker",
      image: "node:20",
      copyToWorktree: ["src", ".env"],
    };
    expect(() => IsolationConfigSchema.parse(cfg)).not.toThrow();
  });

  it("accepts podman as a sandcastle provider", () => {
    expect(() =>
      IsolationConfigSchema.parse({ backend: "sandcastle", provider: "podman" }),
    ).not.toThrow();
  });

  it("rejects an unknown backend value", () => {
    expect(() => IsolationConfigSchema.parse({ backend: "vm" })).toThrow();
  });

  it("rejects a config with no backend field", () => {
    expect(() => IsolationConfigSchema.parse({})).toThrow();
  });

  it("rejects a sandcastle config with an unknown provider", () => {
    expect(() =>
      IsolationConfigSchema.parse({ backend: "sandcastle", provider: "vercel" }),
    ).toThrow();
  });
});

describe("resolveIsolationConfig", () => {
  const wtCfg: IsolationConfig = { backend: "worktree" };
  const scCfg: IsolationConfig = { backend: "sandcastle", provider: "docker" };

  it("returns the worktree default when every layer is undefined", () => {
    expect(resolveIsolationConfig({})).toEqual({ backend: "worktree" });
  });

  it("prefers task over planTask", () => {
    expect(resolveIsolationConfig({ task: scCfg, planTask: wtCfg })).toBe(scCfg);
  });

  it("prefers planTask over plan", () => {
    expect(resolveIsolationConfig({ planTask: scCfg, plan: wtCfg })).toBe(scCfg);
  });

  it("prefers plan over app", () => {
    expect(resolveIsolationConfig({ plan: scCfg, app: wtCfg })).toBe(scCfg);
  });

  it("falls through to app when more-specific layers are undefined", () => {
    expect(resolveIsolationConfig({ app: scCfg })).toBe(scCfg);
  });

  it("ignores undefined layers and picks the next defined one", () => {
    expect(
      resolveIsolationConfig({
        task: undefined,
        planTask: undefined,
        plan: scCfg,
        app: wtCfg,
      }),
    ).toBe(scCfg);
  });
});

describe("createIsolationBackend", () => {
  const args = {
    targetRepoRoot: "/repo",
    harnessRoot: "/harness",
    identifier: "demo",
    runId: "20260506-000000-abcd",
  };

  it("stub-throws for the worktree backend until implemented", async () => {
    await expect(createIsolationBackend({ backend: "worktree" }, args)).rejects.toThrow(
      /WorktreeBackend not yet implemented/,
    );
  });

  it("stub-throws for the sandcastle backend until implemented", async () => {
    await expect(createIsolationBackend({ backend: "sandcastle" }, args)).rejects.toThrow(
      /SandcastleBackend not yet implemented/,
    );
  });

  it("throws on an unknown backend at runtime even when bypassing the type system", async () => {
    await expect(
      createIsolationBackend({ backend: "vm" } as unknown as IsolationConfig, args),
    ).rejects.toThrow(/Unknown isolation backend: vm/);
  });
});
