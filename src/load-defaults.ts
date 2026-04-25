import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export async function loadDefaults<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw);
    if (parsed === null || parsed === undefined) return schema.parse({});
    return schema.parse(parsed);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return schema.parse({});
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
