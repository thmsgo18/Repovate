import * as core from "@actions/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDecide, runRecordHistory } from "./index.js";
import { readHistoryEntry } from "./memory/history.js";

function captureOutputs(): Map<string, string> {
  const outputs = new Map<string, string>();
  vi.spyOn(core, "setOutput").mockImplementation((name: string, value: unknown) => {
    outputs.set(name, String(value));
  });
  return outputs;
}

const INPUT_KEYS = [
  "INPUT_TRIGGER",
  "INPUT_SEVERITY",
  "INPUT_CISA-KEV",
  "INPUT_TESTS-RAN",
  "INPUT_TESTS-PASSED",
  "INPUT_DIFF-PATH",
  "INPUT_ADVISORY-ID",
  "INPUT_STATUS",
  "INPUT_EVENT",
  "INPUT_PACKAGE",
  "INPUT_ECOSYSTEM",
  "INPUT_PR-URL",
  "INPUT_PR-DRAFT",
  "INPUT_AUTONOMY-APPLIED",
  "INPUT_PATCH-ATTEMPTS",
  "INPUT_ALIASES",
  "INPUT_CVSS",
];

function clearInputs(): void {
  for (const key of INPUT_KEYS) delete process.env[key];
}

describe("runDecide", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "repovate-decide-"));
    clearInputs();
  });

  afterEach(async () => {
    clearInputs();
    vi.restoreAllMocks();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("auto-merges a critical CVE with a clean lockfile-only diff and passing tests, using the default config", async () => {
    await writeFile(
      path.join(repoRoot, ".agentconfig.yml"),
      [
        "autonomy:",
        "  default: pr_only",
        "  rules:",
        "    - match: { trigger: cve, severity: [critical, high] }",
        "      action: auto_merge",
        "      conditions: { tests_pass: required, max_files_changed: 5, max_lines_changed: 150 }",
      ].join("\n"),
    );
    const diffPath = path.join(repoRoot, "diff.patch");
    await writeFile(
      diffPath,
      ["diff --git a/package.json b/package.json", "--- a/package.json", "+++ b/package.json", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
    );

    process.env.INPUT_TRIGGER = "cve";
    process.env.INPUT_SEVERITY = "critical";
    process.env["INPUT_CISA-KEV"] = "false";
    process.env["INPUT_TESTS-RAN"] = "true";
    process.env["INPUT_TESTS-PASSED"] = "true";
    process.env["INPUT_DIFF-PATH"] = diffPath;

    const outputs = captureOutputs();
    await runDecide(repoRoot);

    expect(outputs.get("action")).toBe("auto_merge");
    expect(outputs.get("auto-merge-eligible")).toBe("true");
  });

  it("falls back to pr_only when no tests ran, even though the config says auto_merge", async () => {
    await writeFile(
      path.join(repoRoot, ".agentconfig.yml"),
      ["autonomy:", "  default: pr_only", "  rules:", "    - match: { trigger: cve }", "      action: auto_merge"].join("\n"),
    );
    const diffPath = path.join(repoRoot, "diff.patch");
    await writeFile(diffPath, "");

    process.env.INPUT_TRIGGER = "cve";
    process.env.INPUT_SEVERITY = "critical";
    process.env["INPUT_TESTS-RAN"] = "false";
    process.env["INPUT_TESTS-PASSED"] = "true";
    process.env["INPUT_DIFF-PATH"] = diffPath;

    const outputs = captureOutputs();
    await runDecide(repoRoot);

    expect(outputs.get("action")).toBe("pr_only");
    expect(outputs.get("configured-action")).toBe("auto_merge");
    expect(outputs.get("auto-merge-eligible")).toBe("false");
  });

  it("treats a missing/unreadable diff file as an empty diff rather than throwing", async () => {
    process.env.INPUT_TRIGGER = "cve";
    process.env.INPUT_SEVERITY = "low";
    process.env["INPUT_TESTS-RAN"] = "true";
    process.env["INPUT_TESTS-PASSED"] = "true";
    process.env["INPUT_DIFF-PATH"] = path.join(repoRoot, "does-not-exist.patch");

    await expect(runDecide(repoRoot)).resolves.toBeUndefined();
  });
});

describe("runRecordHistory", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "repovate-history-"));
    clearInputs();
  });

  afterEach(async () => {
    clearInputs();
    await rm(repoRoot, { recursive: true, force: true });
  });

  function setBase(): void {
    process.env["INPUT_ADVISORY-ID"] = "GHSA-aaaa-bbbb-cccc";
    process.env.INPUT_PACKAGE = "left-pad";
    process.env.INPUT_ECOSYSTEM = "npm";
    process.env.INPUT_SEVERITY = "high";
    process.env["INPUT_AUTONOMY-APPLIED"] = "pr_only";
  }

  it("creates a new history entry with one event", async () => {
    setBase();
    process.env.INPUT_STATUS = "pr_open";
    process.env.INPUT_EVENT = "pr_opened";
    process.env["INPUT_PR-URL"] = "https://github.com/o/r/pull/1";
    process.env["INPUT_PATCH-ATTEMPTS"] = "1";

    await runRecordHistory(repoRoot);

    const entry = await readHistoryEntry(repoRoot, "GHSA-aaaa-bbbb-cccc");
    expect(entry?.status).toBe("pr_open");
    expect(entry?.pr_url).toBe("https://github.com/o/r/pull/1");
    expect(entry?.history).toHaveLength(1);
    expect(entry?.history[0]?.event).toBe("pr_opened");
  });

  it("appends to an existing entry's event history instead of overwriting it", async () => {
    setBase();
    process.env.INPUT_STATUS = "detected";
    process.env.INPUT_EVENT = "detected";
    await runRecordHistory(repoRoot);

    setBase();
    process.env.INPUT_STATUS = "auto_merged";
    process.env.INPUT_EVENT = "auto_merged";
    process.env["INPUT_AUTONOMY-APPLIED"] = "auto_merge";
    process.env["INPUT_PATCH-ATTEMPTS"] = "1";
    await runRecordHistory(repoRoot);

    const entry = await readHistoryEntry(repoRoot, "GHSA-aaaa-bbbb-cccc");
    expect(entry?.status).toBe("auto_merged");
    expect(entry?.history.map((h) => h.event)).toEqual(["detected", "auto_merged"]);
  });

  it("preserves aliases from a prior write when not given a new value", async () => {
    setBase();
    process.env.INPUT_STATUS = "detected";
    process.env.INPUT_EVENT = "detected";
    process.env.INPUT_ALIASES = "CVE-2026-12345, CVE-2026-99999";
    await runRecordHistory(repoRoot);

    setBase();
    process.env.INPUT_STATUS = "pr_open";
    process.env.INPUT_EVENT = "pr_opened";
    delete process.env.INPUT_ALIASES;
    await runRecordHistory(repoRoot);

    const entry = await readHistoryEntry(repoRoot, "GHSA-aaaa-bbbb-cccc");
    expect(entry?.aliases).toEqual(["CVE-2026-12345", "CVE-2026-99999"]);
  });
});
