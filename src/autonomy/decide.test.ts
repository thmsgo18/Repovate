import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/load.js";
import type { AgentConfig } from "../config/schema.js";
import { decideAutonomy } from "./decide.js";
import type { DiffStats } from "./diff.js";

const SIMPLE_DIFF: DiffStats = {
  files: [{ path: "package.json", linesChanged: 1, category: "manifest" }],
  filesChangedExcludingLockfiles: 1,
  linesChangedExcludingLockfiles: 1,
  touchesSourceFile: false,
  isSimplePatch: true,
};

const SOURCE_TOUCHING_DIFF: DiffStats = {
  ...SIMPLE_DIFF,
  files: [...SIMPLE_DIFF.files, { path: "src/server.ts", linesChanged: 3, category: "source" }],
  touchesSourceFile: true,
  isSimplePatch: false,
};

function configWithRules(rules: unknown[], defaultAction: "pr_only" | "auto_merge" = "pr_only"): AgentConfig {
  return parseConfig({ autonomy: { default: defaultAction, rules } });
}

const AUTO_MERGE_CVE_RULE = {
  match: { trigger: "cve", severity: ["critical", "high"], cisa_kev: "any" },
  action: "auto_merge",
  conditions: { tests_pass: "required", max_files_changed: 5, max_lines_changed: 150 },
};

function baseInput(overrides: Partial<Parameters<typeof decideAutonomy>[0]> = {}) {
  return {
    trigger: "cve" as const,
    severity: "critical" as const,
    cisaKev: false,
    config: configWithRules([AUTO_MERGE_CVE_RULE]),
    diff: SIMPLE_DIFF,
    testsRan: true,
    testsPassed: true,
    ...overrides,
  };
}

describe("decideAutonomy — rule matching", () => {
  it("applies the matching rule's action when everything else is clean", () => {
    const decision = decideAutonomy(baseInput());
    expect(decision.configuredAction).toBe("auto_merge");
    expect(decision.action).toBe("auto_merge");
    expect(decision.autoMergeEligible).toBe(true);
  });

  it("falls back to autonomy.default when no rule matches", () => {
    const decision = decideAutonomy(baseInput({ severity: "low", config: configWithRules([AUTO_MERGE_CVE_RULE], "pr_only") }));
    expect(decision.configuredAction).toBe("pr_only");
    expect(decision.action).toBe("pr_only");
  });

  it("takes the first matching rule when several are present", () => {
    const rules = [
      { match: { trigger: "cve", severity: ["low"] }, action: "pr_only" },
      { match: { trigger: "cve" }, action: "branch_only" },
    ];
    const decision = decideAutonomy(baseInput({ severity: "low", config: configWithRules(rules) }));
    expect(decision.configuredAction).toBe("pr_only");
  });

  it("respects an exact cisa_kev boolean match", () => {
    const rules = [{ match: { trigger: "cve", cisa_kev: true }, action: "auto_merge" }];
    const noKev = decideAutonomy(baseInput({ cisaKev: false, config: configWithRules(rules) }));
    const withKev = decideAutonomy(baseInput({ cisaKev: true, config: configWithRules(rules) }));
    expect(noKev.configuredAction).toBe("pr_only"); // no rule matched, default
    expect(withKev.configuredAction).toBe("auto_merge");
  });
});

describe("decideAutonomy — hard rules (non-overridable)", () => {
  it("never allows eol_dependency to auto_merge, even if a rule somehow said so", () => {
    const rules = [{ match: { trigger: "eol_dependency" }, action: "pr_only" }]; // schema forbids auto_merge here directly
    const decision = decideAutonomy(baseInput({ trigger: "eol_dependency", config: configWithRules(rules) }));
    expect(decision.action).toBe("pr_only");
  });

  it("forces pr_only when the target repo has no test suite", () => {
    const decision = decideAutonomy(baseInput({ testsRan: false }));
    expect(decision.configuredAction).toBe("auto_merge");
    expect(decision.action).toBe("pr_only");
    expect(decision.reasons.some((r) => r.includes("no test suite"))).toBe(true);
  });

  it("forces pr_only when verification failed", () => {
    const decision = decideAutonomy(baseInput({ testsPassed: false }));
    expect(decision.action).toBe("pr_only");
    expect(decision.reasons.some((r) => r.includes("did not pass"))).toBe(true);
  });

  it("forces pr_only when the patch touches a source file, regardless of severity", () => {
    const decision = decideAutonomy(baseInput({ diff: SOURCE_TOUCHING_DIFF }));
    expect(decision.action).toBe("pr_only");
    expect(decision.reasons.some((r) => r.includes("source file"))).toBe(true);
  });

  it("leaves branch_only and pr_only actions untouched by the hard rules", () => {
    const rules = [{ match: { trigger: "new_technology" }, action: "branch_only" }];
    const decision = decideAutonomy(
      baseInput({ trigger: "new_technology", testsRan: false, diff: SOURCE_TOUCHING_DIFF, config: configWithRules(rules) }),
    );
    expect(decision.action).toBe("branch_only");
  });
});

describe("decideAutonomy — per-rule conditions", () => {
  it("downgrades to pr_only when max_files_changed is exceeded", () => {
    const bigDiff: DiffStats = {
      ...SIMPLE_DIFF,
      files: [
        { path: "package.json", linesChanged: 1, category: "manifest" },
        { path: "other-manifest/package.json", linesChanged: 1, category: "manifest" },
      ],
      filesChangedExcludingLockfiles: 6,
    };
    const decision = decideAutonomy(baseInput({ diff: bigDiff }));
    expect(decision.action).toBe("pr_only");
    expect(decision.reasons.some((r) => r.includes("max_files_changed"))).toBe(true);
  });

  it("downgrades to pr_only when max_lines_changed is exceeded", () => {
    const decision = decideAutonomy(baseInput({ diff: { ...SIMPLE_DIFF, linesChangedExcludingLockfiles: 999 } }));
    expect(decision.action).toBe("pr_only");
    expect(decision.reasons.some((r) => r.includes("max_lines_changed"))).toBe(true);
  });

  it("does not downgrade when the rule declares no conditions", () => {
    const rules = [{ match: { trigger: "cve" }, action: "auto_merge" }];
    const decision = decideAutonomy(baseInput({ config: configWithRules(rules), diff: { ...SIMPLE_DIFF, linesChangedExcludingLockfiles: 999 } }));
    expect(decision.action).toBe("auto_merge");
  });
});
