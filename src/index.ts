import { readFile } from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import { onboardingSchema, writeOnboarding } from "./memory/onboarding.js";

/**
 * Claude Code Action already wrote a raw .agent/onboarding.json (Read+Write
 * tools only, no Bash — see .github/workflows/onboard.yml). This step is
 * the trust boundary: it stamps the two fields we don't let an LLM
 * self-report (generated_at, agent_version) and validates the rest against
 * our schema. A mismatch fails the run loudly rather than committing
 * something downstream code can't rely on.
 */
export async function runOnboard(repoPath: string): Promise<void> {
  const rawPath = path.join(repoPath, ".agent", "onboarding.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(rawPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Expected the onboarding analysis step to have written ${rawPath} before this step runs, but it could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const stamped = {
    ...(raw as Record<string, unknown>),
    generated_at: new Date().toISOString(),
    agent_version: process.env.REPOVATE_VERSION ?? "0.0.0-dev",
  };

  const validated = onboardingSchema.parse(stamped);
  await writeOnboarding(repoPath, validated);
  core.info(`Onboarding validated and stamped: ${rawPath}`);
  core.info(JSON.stringify(validated, null, 2));
}

async function run(): Promise<void> {
  const step = core.getInput("step", { required: true });
  const repoPath = core.getInput("repo-path") || ".";

  switch (step) {
    case "onboard":
      await runOnboard(repoPath);
      break;
    default:
      core.info(`Repovate — step "${step}" is not implemented yet (Phase 1 in progress).`);
  }
}

// Only run as a side effect when this file is the process entry point
// (`node dist/index.js`) — importing it from tests must not trigger a run.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
