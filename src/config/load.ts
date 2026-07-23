import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { agentConfigSchema, type AgentConfig } from "./schema.js";

export const CONFIG_FILENAME = ".agentconfig.yml";

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Loads and validates .agentconfig.yml from a repo root.
 * A missing file is not an error — it resolves to the schema defaults,
 * matching the "réglage par défaut raisonnable" requirement.
 */
export async function loadConfig(repoRoot: string): Promise<AgentConfig> {
  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return parseConfig({});
    }
    throw error;
  }
  return parseConfig(parseYaml(raw) ?? {});
}

/** Validates an already-parsed config object. A malformed file must fail the run, never silently fall back to a default. */
export function parseConfig(raw: unknown): AgentConfig {
  const result = agentConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigValidationError(
      `Invalid ${CONFIG_FILENAME}: ${issues.length} issue(s) found`,
      issues,
    );
  }
  return result.data;
}
