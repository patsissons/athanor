import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

/** Name of the athanor directory inside target repos. */
export const ATHANOR_DIR = ".athanor";

// This file lives at <harnessRoot>/src/paths.ts
// So harnessRoot is one directory up.
const here = dirname(fileURLToPath(import.meta.url));
export const harnessRoot = resolve(here, "..");

export async function resolveTargetRepoRoot(cwd: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`athanor must be run from within a git repository (${cwd} is not inside one)`);
  }
  return result.stdout.trim();
}

/** Resolve a path within the target repo's .athanor directory. */
export function resolveAthanorPath(targetRepoRoot: string, ...segments: string[]): string {
  return resolve(targetRepoRoot, ATHANOR_DIR, ...segments);
}

/**
 * Resolve a task file path, trying the literal path first, then falling back
 * to prepending .athanor/ if the literal path doesn't exist.
 */
export function resolveTaskFilePath(inputPath: string, targetRepoRoot: string): string {
  const literal = resolve(inputPath);
  if (existsSync(literal)) return literal;

  const fallback = resolve(targetRepoRoot, ATHANOR_DIR, inputPath);
  if (existsSync(fallback)) return fallback;

  // Return the literal path so the downstream error message makes sense.
  return literal;
}
