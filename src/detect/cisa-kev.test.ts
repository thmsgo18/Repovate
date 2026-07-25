import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCisaKev, fetchCisaKevCatalog } from "./cisa-kev.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body } as unknown as Response;
}

describe("CISA KEV", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the catalog once and indexes it by CVE id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vulnerabilities: [
          {
            cveID: "CVE-2026-16232",
            vulnerabilityName: "Check Point SmartConsole Improper Authentication Vulnerability",
            dateAdded: "2026-07-22",
            dueDate: "2026-07-25",
            knownRansomwareCampaignUse: "Unknown",
          },
          {
            cveID: "CVE-2020-1234",
            vulnerabilityName: "Some Ransomware-Used Bug",
            dateAdded: "2020-01-01",
            dueDate: "2020-01-15",
            knownRansomwareCampaignUse: "Known",
          },
        ],
      }),
    );

    const catalog = await fetchCisaKevCatalog();

    expect(fetchMock).toHaveBeenCalledWith("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
    expect(catalog.size).toBe(2);
    expect(catalog.get("CVE-2026-16232")?.knownRansomwareCampaignUse).toBe(false);
    expect(catalog.get("CVE-2020-1234")?.knownRansomwareCampaignUse).toBe(true);
  });

  it("checkCisaKev matches on any alias, without a network call", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vulnerabilities: [
          {
            cveID: "CVE-2020-1234",
            vulnerabilityName: "Exploited bug",
            dateAdded: "2020-01-01",
            dueDate: "2020-01-15",
            knownRansomwareCampaignUse: "Known",
          },
        ],
      }),
    );
    const catalog = await fetchCisaKevCatalog();
    fetchMock.mockClear();

    const match = checkCisaKev(catalog, ["GHSA-xxxx-yyyy-zzzz", "CVE-2020-1234"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(match?.vulnerabilityName).toBe("Exploited bug");
  });

  it("checkCisaKev returns null when no alias is in the catalog", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vulnerabilities: [] }));
    const catalog = await fetchCisaKevCatalog();

    expect(checkCisaKev(catalog, ["CVE-2099-9999"])).toBeNull();
  });

  it("throws a descriptive error on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503));
    await expect(fetchCisaKevCatalog()).rejects.toThrow(/CISA KEV.*503/);
  });
});
