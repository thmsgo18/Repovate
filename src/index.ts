import { readFile } from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import { decideAutonomy, parseDiffStats } from "./autonomy/index.js";
import { actionSchema, severitySchema, triggerSchema } from "./config/schema.js";
import { loadConfig } from "./config/load.js";
import { onboardingSchema, writeOnboarding } from "./memory/onboarding.js";
import { historyStatusSchema, readHistoryEntry, writeHistoryEntry, type HistoryEntry } from "./memory/history.js";

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

/**
 * Phase 4 (docs/architecture.md section 4/7): resolves the final autonomy
 * action for one finding by combining .agentconfig.yml with the actual
 * outcome of the patch/verify pipeline (diff shape, whether tests ran and
 * passed). Called from remediate.yml's publish job, after verification —
 * never before, since the hard rules need real test/diff results, not
 * predictions.
 */
export async function runDecide(repoPath: string): Promise<void> {
  const trigger = triggerSchema.parse(core.getInput("trigger", { required: true }));
  const severity = severitySchema.parse(core.getInput("severity", { required: true }));
  const cisaKev = core.getInput("cisa-kev") === "true";
  const testsRan = core.getInput("tests-ran") === "true";
  const testsPassed = core.getInput("tests-passed") === "true";
  const diffPath = core.getInput("diff-path");

  const config = await loadConfig(repoPath);

  let diffText = "";
  if (diffPath) {
    try {
      diffText = await readFile(diffPath, "utf8");
    } catch (error) {
      core.warning(
        `Could not read diff at ${diffPath}, treating it as empty (no files changed): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const decision = decideAutonomy({ trigger, severity, cisaKev, config, diff: parseDiffStats(diffText), testsRan, testsPassed });

  core.setOutput("action", decision.action);
  core.setOutput("configured-action", decision.configuredAction);
  core.setOutput("auto-merge-eligible", String(decision.autoMergeEligible));
  core.info(`Autonomy decision for trigger=${trigger} severity=${severity}: ${decision.action} (configured: ${decision.configuredAction})`);
  for (const reason of decision.reasons) core.info(`  - ${reason}`);
}

/**
 * Appends one event to .agent/history/<id>.json, creating it on first
 * write. This is the durable audit trail docs/architecture.md section 5.3
 * describes — versioned with the code, human-readable — and the dedup
 * check future runs use to skip a finding already past "detected".
 */
export async function runRecordHistory(repoPath: string): Promise<void> {
  const id = core.getInput("advisory-id", { required: true });
  const status = historyStatusSchema.parse(core.getInput("status", { required: true }));
  const event = core.getInput("event", { required: true });
  const packageName = core.getInput("package", { required: true });
  const ecosystem = core.getInput("ecosystem", { required: true });
  const severity = severitySchema.parse(core.getInput("severity", { required: true }));
  const cisaKev = core.getInput("cisa-kev") === "true";
  const prUrl = core.getInput("pr-url") || null;
  const prDraft = core.getInput("pr-draft") === "true";
  const autonomyApplied = actionSchema.parse(core.getInput("autonomy-applied", { required: true }));
  const patchAttempts = Number(core.getInput("patch-attempts") || "0");
  const aliasesInput = core.getInput("aliases");

  const cvssInput = core.getInput("cvss");
  let cvss: number | null = null;
  if (cvssInput) {
    const parsed = Number(cvssInput);
    cvss = Number.isFinite(parsed) ? parsed : null;
  }

  const existing = await readHistoryEntry(repoPath, id);
  const entry: HistoryEntry = {
    id,
    aliases: aliasesInput ? aliasesInput.split(",").map((a) => a.trim()).filter(Boolean) : (existing?.aliases ?? []),
    package: packageName,
    ecosystem,
    severity,
    cvss,
    cisa_kev: cisaKev,
    status,
    pr_url: prUrl,
    pr_draft: prDraft,
    autonomy_applied: autonomyApplied,
    patch_attempts: patchAttempts,
    history: [...(existing?.history ?? []), { at: new Date().toISOString(), event }],
  };

  await writeHistoryEntry(repoPath, entry);
  core.info(`History updated: ${id} -> ${status} (${event})`);
}

async function run(): Promise<void> {
  const step = core.getInput("step", { required: true });
  const repoPath = core.getInput("repo-path") || ".";

  switch (step) {
    case "onboard":
      await runOnboard(repoPath);
      break;
    case "decide":
      await runDecide(repoPath);
      break;
    case "record-history":
      await runRecordHistory(repoPath);
      break;
    default:
      core.info(`Repovate — step "${step}" is not implemented yet.`);
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
