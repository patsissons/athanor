import { minimatch } from "minimatch";

export type PathPolicyFailureReason = "allowedPaths" | "forbiddenPaths";

export interface PathPolicyResult {
  ok: boolean;
  outOfScope: string[];
  forbiddenHits: string[];
  retryReason: PathPolicyFailureReason | null;
  message: string | null;
}

function formatFileList(label: string, files: string[]): string {
  return `${label}:\n${files.map((file) => `  - ${file}`).join("\n")}`;
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern));
}

export function evaluatePathPolicy(
  changedFiles: string[],
  allowedPaths: string[],
  forbiddenPaths: string[],
): PathPolicyResult {
  const outOfScope = allowedPaths.length
    ? changedFiles.filter((file) => !matchesAny(file, allowedPaths))
    : [];
  const forbiddenHits = forbiddenPaths.length
    ? changedFiles.filter((file) => matchesAny(file, forbiddenPaths))
    : [];

  if (outOfScope.length === 0 && forbiddenHits.length === 0) {
    return {
      ok: true,
      outOfScope,
      forbiddenHits,
      retryReason: null,
      message: null,
    };
  }

  const sections: string[] = [];
  if (outOfScope.length) {
    sections.push(formatFileList("Agent modified files outside allowedPaths", outOfScope));
  }
  if (forbiddenHits.length) {
    sections.push(formatFileList("Agent modified forbidden files", forbiddenHits));
  }

  return {
    ok: false,
    outOfScope,
    forbiddenHits,
    retryReason: outOfScope.length ? "allowedPaths" : "forbiddenPaths",
    message: sections.join("\n\n"),
  };
}
