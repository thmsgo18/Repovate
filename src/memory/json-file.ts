import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

/**
 * Shared read path for every .agent/*.json file. A run of this pipeline is
 * unattended (cron), so a bare JSON.parse SyntaxError with no file path is
 * useless after the fact — always identify which file was corrupt.
 */
export async function readJsonFile<T>(filePath: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath} as JSON: ${(error as Error).message}`);
  }
  return schema.parse(json);
}

export async function writeJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  data: T,
): Promise<void> {
  const validated = schema.parse(data);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}
