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

function isYamlObject(text: string): boolean {
  try {
    const result = parse(text);
    return result !== null && typeof result === "object" && !Array.isArray(result);
  } catch {
    return false;
  }
}
