import { parse } from "yaml";

/**
 * Extract valid YAML from raw agent output. Handles:
 *   1. Pure YAML (the entire string is valid YAML producing an object)
 *   2. Markdown-fenced YAML (```yaml ... ``` or ``` ... ```)
 *   3. Throws if no valid YAML can be extracted
 */
export function extractYaml(raw: string): string {
  const trimmed = raw.trim();

  // Try the whole string as YAML first.
  if (isYamlObject(trimmed)) return trimmed;

  // Look for a fenced block.
  const fenced = extractFencedBlock(trimmed);
  if (fenced && isYamlObject(fenced)) return fenced;

  // Try stripping leading prose lines (non-YAML preamble) until we hit a
  // line that looks like a YAML key (e.g. "id: ...").  This handles the case
  // where the agent emits conversational text before the raw YAML.
  const stripped = stripLeadingProse(trimmed);
  if (stripped && isYamlObject(stripped)) return stripped;

  throw new Error(
    "Could not extract valid YAML from agent output. " +
      `First 200 chars: ${trimmed.slice(0, 200)}`,
  );
}

function extractFencedBlock(text: string): string | null {
  // Match ```yaml ... ``` or ``` ... ```
  const match = text.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function stripLeadingProse(text: string): string | null {
  // Find the first line that looks like a YAML key (word characters followed by colon)
  const lines = text.split("\n");
  const idx = lines.findIndex((line) => /^\w[\w-]*\s*:/.test(line));
  if (idx <= 0) return null; // nothing to strip, or already at the start
  return lines.slice(idx).join("\n").trim();
}

function isYamlObject(text: string): boolean {
  try {
    const result = parse(text);
    return result !== null && typeof result === "object" && !Array.isArray(result);
  } catch {
    return false;
  }
}
