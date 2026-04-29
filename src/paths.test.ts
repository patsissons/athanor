import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { execa } from "execa";
import {
  ATHANOR_DIR,
  resolveAthanorPath,
  resolveTargetRepoRoot,
  resolveTaskFilePath,
} from "./paths.js";

describe("resolveAthanorPath", () => {
  it("joins target root with .athanor and the given segments", () => {
    const root = sep === "/" ? "/repo" : "C:\\repo";
    expect(resolveAthanorPath(root, "tasks", "foo.yaml")).toBe(
      resolve(root, ATHANOR_DIR, "tasks", "foo.yaml"),
    );
  });

  it("returns the .athanor directory itself when no segments are given", () => {
    const root = sep === "/" ? "/repo" : "C:\\repo";
    expect(resolveAthanorPath(root)).toBe(resolve(root, ATHANOR_DIR));
  });
});

describe("resolveTaskFilePath", () => {
  let tmp: string;
  let athanor: string;

  beforeAll(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), "athanor-paths-"));
    athanor = resolve(tmp, ATHANOR_DIR, "tasks");
    await mkdir(athanor, { recursive: true });
    await writeFile(resolve(tmp, "literal.yaml"), "id: literal\n");
    await writeFile(resolve(athanor, "fallback.yaml"), "id: fallback\n");
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the literal absolute path when it exists", () => {
    const literal = resolve(tmp, "literal.yaml");
    expect(resolveTaskFilePath(literal, tmp)).toBe(literal);
  });

  it("falls back to .athanor/<input> when the literal path does not exist", () => {
    const input = "tasks/fallback.yaml";
    expect(resolveTaskFilePath(input, tmp)).toBe(resolve(athanor, "fallback.yaml"));
  });

  it("returns the literal path when neither location exists, so downstream errors stay user-friendly", () => {
    const input = "tasks/does-not-exist.yaml";
    const result = resolveTaskFilePath(input, tmp);
    // The literal path is `resolve(input)` against process.cwd(); we only assert
    // that it's NOT the .athanor fallback (so a 'file not found' error references
    // the path the user actually typed).
    expect(result).not.toBe(resolve(tmp, ATHANOR_DIR, input));
    expect(result).toBe(resolve(input));
  });
});

describe("resolveTargetRepoRoot", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), "athanor-paths-norepo-"));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the toplevel of the git repo containing cwd", async () => {
    const expected = (await execa("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }))
      .stdout;
    await expect(resolveTargetRepoRoot(process.cwd())).resolves.toBe(expected);
  });

  it("throws a helpful error when cwd is not inside a git repo", async () => {
    await expect(resolveTargetRepoRoot(tmp)).rejects.toThrow(/not inside one/);
  });
});
