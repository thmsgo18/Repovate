import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNvdEnrichment } from "./nvd.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body } as unknown as Response;
}

describe("fetchNvdEnrichment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers NVD's own Primary CVSS score over a mirrored Secondary one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vulnerabilities: [
          {
            cve: {
              id: "CVE-2024-43796",
              descriptions: [
                { lang: "es", value: "descripcion en espanol" },
                { lang: "en", value: "English description" },
              ],
              metrics: {
                cvssMetricV31: [
                  { source: "security-advisories@github.com", type: "Secondary", cvssData: { baseScore: 5, vectorString: "x" } },
                  { source: "nvd@nist.gov", type: "Primary", cvssData: { baseScore: 4.7, vectorString: "y" } },
                ],
              },
            },
          },
        ],
      }),
    );

    const result = await fetchNvdEnrichment("CVE-2024-43796");

    expect(result).toEqual({ cveId: "CVE-2024-43796", cvss: 4.7, description: "English description" });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2024-43796");
  });

  it("falls back to whatever metric is available when there is no Primary", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vulnerabilities: [
          {
            cve: {
              id: "CVE-2020-0001",
              descriptions: [{ lang: "en", value: "desc" }],
              metrics: {
                cvssMetricV2: [{ source: "x", type: "Secondary", cvssData: { baseScore: 7.5, vectorString: "z" } }],
              },
            },
          },
        ],
      }),
    );

    const result = await fetchNvdEnrichment("CVE-2020-0001");
    expect(result?.cvss).toBe(7.5);
  });

  it("returns null (not an error) when NVD has no record for this CVE — e.g. a GHSA-only advisory", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vulnerabilities: [] }));
    expect(await fetchNvdEnrichment("CVE-2099-99999")).toBeNull();
  });

  it("returns null with no cvss when the CVE exists but has no metrics yet", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ vulnerabilities: [{ cve: { id: "CVE-2026-1", descriptions: [{ lang: "en", value: "d" }] } }] }),
    );
    const result = await fetchNvdEnrichment("CVE-2026-1");
    expect(result).toEqual({ cveId: "CVE-2026-1", cvss: null, description: "d" });
  });

  it("sends the apiKey header only when a key is provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vulnerabilities: [] }));
    await fetchNvdEnrichment("CVE-2026-1", "my-key");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.apiKey).toBe("my-key");

    fetchMock.mockResolvedValueOnce(jsonResponse({ vulnerabilities: [] }));
    await fetchNvdEnrichment("CVE-2026-1");
    const [, init2] = fetchMock.mock.calls[1]!;
    expect(init2.headers.apiKey).toBeUndefined();
  });

  it("throws a descriptive error on a non-ok response (e.g. rate limited)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 429));
    await expect(fetchNvdEnrichment("CVE-2026-1")).rejects.toThrow(/429/);
  });
});
