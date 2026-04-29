import { describe, expect, it } from "vitest";
import { extractYaml } from "./yaml-extract.js";

describe("extractYaml", () => {
  it("returns pure YAML as-is", () => {
    const yaml = "id: test\ntasks:\n  - id: t1\n    description: do something";
    expect(extractYaml(yaml)).toBe(yaml);
  });

  it("extracts YAML from markdown fences", () => {
    const input = "Here is the plan:\n\n```yaml\nid: test\nname: Test Plan\n```\n\nDone.";
    expect(extractYaml(input)).toBe("id: test\nname: Test Plan");
  });

  it("extracts YAML from plain fences (no language tag)", () => {
    const input = "```\nid: test\nname: Test Plan\n```";
    expect(extractYaml(input)).toBe("id: test\nname: Test Plan");
  });

  it("handles leading/trailing whitespace", () => {
    const input = "  \nid: test\nname: foo\n  ";
    expect(extractYaml(input)).toBe("id: test\nname: foo");
  });

  it("throws on non-YAML content", () => {
    expect(() => extractYaml("This is just plain text.")).toThrow(/Could not extract/);
  });

  it("throws on empty input", () => {
    expect(() => extractYaml("")).toThrow(/Could not extract/);
  });

  it("throws when YAML parses to a scalar", () => {
    expect(() => extractYaml("hello world")).toThrow(/Could not extract/);
  });

  it("throws when YAML parses to an array", () => {
    expect(() => extractYaml("- one\n- two")).toThrow(/Could not extract/);
  });

  it("extracts YAML preceded by conversational prose", () => {
    const input =
      "Now I have a complete picture. Let me produce the plan.\n\n" +
      "id: build-app-v1\n" +
      "name: Build App v1\n" +
      "description: |\n" +
      "  Build the full app.\n" +
      "tasks:\n" +
      "  - id: t1\n" +
      "    description: do something";
    const result = extractYaml(input);
    expect(result).toContain("id: build-app-v1");
    expect(result).not.toContain("complete picture");
  });

  it("extracts YAML preceded by multiple prose lines", () => {
    const input = "Here is my analysis.\nI will now generate the plan.\n\nid: test\nname: foo";
    expect(extractYaml(input)).toBe("id: test\nname: foo");
  });
});
