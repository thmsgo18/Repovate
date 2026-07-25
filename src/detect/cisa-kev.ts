const CISA_KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

interface CisaKevRawEntry {
  cveID: string;
  vulnerabilityName: string;
  dateAdded: string;
  dueDate: string;
  knownRansomwareCampaignUse: string;
}

interface CisaKevRawCatalog {
  vulnerabilities: CisaKevRawEntry[];
}

export interface CisaKevMatch {
  cveId: string;
  vulnerabilityName: string;
  dateAdded: string;
  dueDate: string;
  /** CISA reports this as the string "Known"/"Unknown", not a boolean — normalized here. */
  knownRansomwareCampaignUse: boolean;
}

export type CisaKevCatalog = Map<string, CisaKevMatch>;

/**
 * Fetches the full KEV catalog once. docs/architecture.md section 6: this is
 * an enrichment source (checked by CVE id once one is already known via
 * OSV/GHSA), never a discovery source — there's no per-package query here.
 */
export async function fetchCisaKevCatalog(): Promise<CisaKevCatalog> {
  const response = await fetch(CISA_KEV_URL);
  if (!response.ok) {
    throw new Error(`CISA KEV catalog request failed: ${response.status} ${response.statusText}`);
  }
  const raw = (await response.json()) as CisaKevRawCatalog;

  const catalog: CisaKevCatalog = new Map();
  for (const entry of raw.vulnerabilities) {
    catalog.set(entry.cveID, {
      cveId: entry.cveID,
      vulnerabilityName: entry.vulnerabilityName,
      dateAdded: entry.dateAdded,
      dueDate: entry.dueDate,
      knownRansomwareCampaignUse: entry.knownRansomwareCampaignUse === "Known",
    });
  }
  return catalog;
}

/** Checks a set of aliases (as returned by OSV/GHSA) against an already-fetched catalog — no network call. */
export function checkCisaKev(catalog: CisaKevCatalog, aliases: string[]): CisaKevMatch | null {
  for (const alias of aliases) {
    const match = catalog.get(alias);
    if (match) return match;
  }
  return null;
}
