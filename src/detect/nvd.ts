const NVD_API_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";

interface NvdCvssMetric {
  source: string;
  type: "Primary" | "Secondary";
  cvssData: { baseScore: number; vectorString: string };
}

interface NvdCveResponse {
  vulnerabilities?: Array<{
    cve: {
      id: string;
      descriptions: Array<{ lang: string; value: string }>;
      metrics?: {
        cvssMetricV31?: NvdCvssMetric[];
        cvssMetricV30?: NvdCvssMetric[];
        cvssMetricV2?: NvdCvssMetric[];
      };
    };
  }>;
}

export interface NvdEnrichment {
  cveId: string;
  /** NVD's own reference CVSS base score. Null if NVD has no metric for this CVE yet. */
  cvss: number | null;
  description: string | null;
}

/**
 * Enrichment only (docs/architecture.md section 6) — NVD's CPE-based
 * package matching is unreliable for discovery, so this is queried by CVE
 * id once one is already known via OSV/GHSA, never by package name.
 * Returns null for a CVE NVD doesn't know about (e.g. GHSA-only advisories
 * with no CVE alias) rather than throwing — that's an expected, common case.
 */
export async function fetchNvdEnrichment(cveId: string, apiKey?: string): Promise<NvdEnrichment | null> {
  const url = `${NVD_API_BASE}?cveId=${encodeURIComponent(cveId)}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.apiKey = apiKey;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`NVD request failed for ${cveId}: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as NvdCveResponse;
  const cve = body.vulnerabilities?.[0]?.cve;
  if (!cve) return null;

  // Prefer NVD's own "Primary" score over a mirrored "Secondary" one (often
  // sourced from GHSA); fall back to whatever's available, preferring the
  // newest CVSS version.
  const candidates = [
    ...(cve.metrics?.cvssMetricV31 ?? []),
    ...(cve.metrics?.cvssMetricV30 ?? []),
    ...(cve.metrics?.cvssMetricV2 ?? []),
  ];
  const chosen = candidates.find((m) => m.type === "Primary") ?? candidates[0];

  return {
    cveId: cve.id,
    cvss: chosen?.cvssData.baseScore ?? null,
    description: cve.descriptions.find((d) => d.lang === "en")?.value ?? null,
  };
}
