import path from "node:path";

export const AGENT_DIR = ".agent";
export const ONBOARDING_FILENAME = "onboarding.json";
export const STATE_FILENAME = "state.json";
export const HISTORY_DIRNAME = "history";

// Advisory ids (GHSA-xxxx-xxxx-xxxx, CVE-YYYY-NNNNN) come from external,
// untrusted sources — validate the charset before using one as a filename
// to rule out path traversal.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function agentDir(repoRoot: string): string {
  return path.join(repoRoot, AGENT_DIR);
}

export function onboardingPath(repoRoot: string): string {
  return path.join(agentDir(repoRoot), ONBOARDING_FILENAME);
}

export function statePath(repoRoot: string): string {
  return path.join(agentDir(repoRoot), STATE_FILENAME);
}

export function historyDir(repoRoot: string): string {
  return path.join(agentDir(repoRoot), HISTORY_DIRNAME);
}

export function historyEntryPath(repoRoot: string, id: string): string {
  return path.join(historyDir(repoRoot), `${assertSafeId(id)}.json`);
}

function assertSafeId(id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(`Invalid advisory id for history filename: ${JSON.stringify(id)}`);
  }
  return id;
}
