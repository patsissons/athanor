import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

// Integration tests: spawn the CLI as a child process via the same bin
// script users invoke and assert on exit codes / output. We only exercise
// argument-validation and informational paths so no test ever invokes
// Claude itself.

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "..");
const binPath = resolve(harnessRoot, "bin", "athanor");

async function runCli(args: string[], opts: { cwd?: string } = {}) {
  return execa(binPath, args, {
    cwd: opts.cwd,
    reject: false,
  });
}

describe("athanor CLI", () => {
  describe("--version", () => {
    it("prints the package version and exits 0", async () => {
      const result = await runCli(["--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("--help", () => {
    it("lists all top-level subcommands", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      // Confirm each subcommand surface introduced or kept on this branch.
      for (const sub of ["run", "plan", "run-plan", "clean", "init"]) {
        expect(result.stdout).toContain(sub);
      }
    });
  });

  describe("missing-argument validation", () => {
    it("rejects `run` with no task path argument", async () => {
      const result = await runCli(["run"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/missing required argument|task-path/i);
    });

    it("rejects `run-plan` with no plan path argument", async () => {
      const result = await runCli(["run-plan"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/missing required argument|plan-path/i);
    });

    it("rejects `plan` with --stop-after set to an invalid phase", async () => {
      // Use a tmp git repo so we don't trip the not-in-a-git-repo check first.
      const tmp = await mkdtemp(resolve(tmpdir(), "athanor-cli-stopafter-"));
      try {
        await execa("git", ["init"], { cwd: tmp });
        const result = await runCli(["plan", "Add a thing", "--stop-after", "bogus"], {
          cwd: tmp,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/--stop-after must be 'plan' or 'tasks'/);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("not-a-git-repo guardrail", () => {
    let nonRepo: string;

    beforeAll(async () => {
      nonRepo = await mkdtemp(resolve(tmpdir(), "athanor-cli-norepo-"));
    });

    afterAll(async () => {
      await rm(nonRepo, { recursive: true, force: true });
    });

    it("`run` exits 1 with a clear error when invoked outside a git repo", async () => {
      const result = await runCli(["run", "foo.yaml"], { cwd: nonRepo });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/git repository/i);
    });

    it("`plan` exits 1 with a clear error when invoked outside a git repo", async () => {
      const result = await runCli(["plan", "Add a thing"], { cwd: nonRepo });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/git repository/i);
    });

    it("`clean --dry-run --all` exits 1 when invoked outside a git repo", async () => {
      const result = await runCli(["clean", "--dry-run", "--all"], { cwd: nonRepo });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/git repository/i);
    });
  });

  describe("clean --dry-run --all", () => {
    let repo: string;

    beforeAll(async () => {
      repo = await mkdtemp(resolve(tmpdir(), "athanor-cli-clean-"));
      await execa("git", ["init"], { cwd: repo });
    });

    afterAll(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it("succeeds in an empty git repo with no athanor worktrees to clean", async () => {
      const result = await runCli(["clean", "--dry-run", "--all"], { cwd: repo });
      expect(result.exitCode).toBe(0);
    });
  });
});
