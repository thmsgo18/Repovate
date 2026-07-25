import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CisaKevCatalog } from "./cisa-kev.js";
import { correlateAdvisories } from "./correlate.js";
import type { NormalizedAdvisory } from "./types.js";

function adv(overrides: Partial<NormalizedAdvisory>): NormalizedAdvisory {
  return {
    id: "GHSA-aaaa",
    aliases: [],
    summary: "summary",
    severity: "high",
    package: "express",
    ecosystem: "npm",
    affectedVersion: "4.18.2",
    source: "osv",
    url: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body } as unknown as Response;
}

describe("correlateAdvisories", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ vulnerabilities: [] }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges an OSV and a GHSA entry that share a CVE alias, preferring GHSA's summary", async () => {
    const osv = adv({ id: "GHSA-qw6h", aliases: ["CVE-2024-43796"], source: "osv", summary: "OSV's raw text" });
    const ghsa = adv({ id: "GHSA-qw6h", aliases: ["CVE-2024-43796"], source: "ghsa", summary: "GHSA's structured summary" });

    const result = await correlateAdvisories([osv, ghsa]);

    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toBe("GHSA's structured summary");
    expect(result[0]!.source).toBe("ghsa");
    expect(result[0]!.mergedFrom.sort()).toEqual(["ghsa:GHSA-qw6h", "osv:GHSA-qw6h"]);
    expect(result[0]!.aliases).toEqual(["CVE-2024-43796"]);
  });

  it("does NOT merge the same GHSA id when it affects a different resolved version of the package", async () => {
    // Regression scenario from the real Neurovent run: uuid direct @9.0.1
    // and a transitive copy @8.3.2 both hit by GHSA-w5hq — different
    // remediation targets, must stay separate.
    const direct = adv({ id: "GHSA-w5hq", package: "uuid", affectedVersion: "9.0.1" });
    const transitive = adv({ id: "GHSA-w5hq", package: "uuid", affectedVersion: "8.3.2" });

    const result = await correlateAdvisories([direct, transitive]);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.affectedVersion).sort()).toEqual(["8.3.2", "9.0.1"]);
  });

  it("does not merge unrelated advisories with no shared alias", async () => {
    const a = adv({ id: "GHSA-aaaa", package: "express" });
    const b = adv({ id: "GHSA-bbbb", package: "multer" });

    const result = await correlateAdvisories([a, b]);
    expect(result).toHaveLength(2);
  });

  it("transitively merges a 3-way chain (A-B share alias X, B-C share alias Y)", async () => {
    const a = adv({ id: "GHSA-a", aliases: ["CVE-shared-1"] });
    const b = adv({ id: "GHSA-a", aliases: ["CVE-shared-2"], source: "ghsa" });
    const c = adv({ id: "GHSA-c", aliases: ["CVE-shared-2"] });

    const result = await correlateAdvisories([a, b, c]);

    expect(result).toHaveLength(1);
    expect(result[0]!.mergedFrom).toHaveLength(3);
  });

  it("enriches with NVD's CVSS score when a CVE alias is present", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vulnerabilities: [
          {
            cve: {
              id: "CVE-2024-43796",
              descriptions: [{ lang: "en", value: "d" }],
              metrics: { cvssMetricV31: [{ source: "nvd@nist.gov", type: "Primary", cvssData: { baseScore: 4.7, vectorString: "x" } }] },
            },
          },
        ],
      }),
    );

    const result = await correlateAdvisories([adv({ aliases: ["CVE-2024-43796"] })]);

    expect(result[0]!.cvss).toBe(4.7);
  });

  it("leaves cvss null when there is no CVE alias to look up", async () => {
    const result = await correlateAdvisories([adv({ id: "GHSA-only", aliases: [] })]);
    expect(result[0]!.cvss).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves cvss null (not throwing) when the NVD lookup itself fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 429));
    const result = await correlateAdvisories([adv({ aliases: ["CVE-2024-1"] })]);
    expect(result[0]!.cvss).toBeNull();
  });

  it("marks cisaKev when a pre-fetched catalog contains a matching alias", async () => {
    const catalog: CisaKevCatalog = new Map([
      [
        "CVE-2021-44228",
        { cveId: "CVE-2021-44228", vulnerabilityName: "Log4Shell", dateAdded: "2021-12-10", dueDate: "2021-12-24", knownRansomwareCampaignUse: true },
      ],
    ]);

    const result = await correlateAdvisories([adv({ id: "GHSA-log4j", aliases: ["CVE-2021-44228"] })], { cisaKev: catalog });

    expect(result[0]!.cisaKev).toEqual({ dateAdded: "2021-12-10", dueDate: "2021-12-24", knownRansomwareCampaignUse: true });
  });

  it("leaves cisaKev null when no catalog is provided or no match is found", async () => {
    const withoutCatalog = await correlateAdvisories([adv({ aliases: ["CVE-2021-44228"] })]);
    expect(withoutCatalog[0]!.cisaKev).toBeNull();

    const emptyCatalog: CisaKevCatalog = new Map();
    const noMatch = await correlateAdvisories([adv({ aliases: ["CVE-2021-44228"] })], { cisaKev: emptyCatalog });
    expect(noMatch[0]!.cisaKev).toBeNull();
  });
});
