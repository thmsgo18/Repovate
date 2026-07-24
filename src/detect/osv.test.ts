import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DependencyRef } from "../manifests/types.js";
import { fetchOsvAdvisories } from "./osv.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

function dep(overrides: Partial<DependencyRef> = {}): DependencyRef {
  return { name: "express", version: "4.18.2", ecosystem: "npm", direct: true, manifestPath: "package.json", ...overrides };
}

describe("fetchOsvAdvisories", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an empty array without any network call when there are no dependencies", async () => {
    const result = await fetchOsvAdvisories([]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("batches the query, fetches details, and normalizes the result", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ vulns: [{ id: "GHSA-qw6h-vgh9-j6wx", modified: "2026-02-04T00:00:00Z" }] }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "GHSA-qw6h-vgh9-j6wx",
          summary: "express vulnerable to XSS via response.redirect()",
          aliases: ["CVE-2024-43796"],
          database_specific: { severity: "LOW" },
          references: [
            { type: "WEB", url: "https://github.com/expressjs/express/security/advisories/GHSA-qw6h-vgh9-j6wx" },
            { type: "ADVISORY", url: "https://nvd.nist.gov/vuln/detail/CVE-2024-43796" },
          ],
        }),
      );

    const [advisory] = await fetchOsvAdvisories([dep()]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [batchUrl, batchInit] = fetchMock.mock.calls[0]!;
    expect(batchUrl).toBe("https://api.osv.dev/v1/querybatch");
    expect(JSON.parse(batchInit.body)).toEqual({
      queries: [{ package: { name: "express", ecosystem: "npm" }, version: "4.18.2" }],
    });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.osv.dev/v1/vulns/GHSA-qw6h-vgh9-j6wx");

    expect(advisory).toEqual({
      id: "GHSA-qw6h-vgh9-j6wx",
      aliases: ["CVE-2024-43796"],
      summary: "express vulnerable to XSS via response.redirect()",
      severity: "low",
      package: "express",
      ecosystem: "npm",
      affectedVersion: "4.18.2",
      source: "osv",
      url: "https://nvd.nist.gov/vuln/detail/CVE-2024-43796",
    });
  });

  it("fetches each unique advisory id only once, even if it affects several dependencies", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { vulns: [{ id: "GHSA-shared", modified: "2026-01-01T00:00:00Z" }] },
            { vulns: [{ id: "GHSA-shared", modified: "2026-01-01T00:00:00Z" }] },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "GHSA-shared", summary: "shared advisory", aliases: [] }));

    const deps = [dep({ name: "left-pad", version: "1.0.0" }), dep({ name: "left-pad", version: "1.0.1" })];
    const advisories = await fetchOsvAdvisories(deps);

    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 batch call + 1 detail call, not 2 detail calls
    expect(advisories).toHaveLength(2);
    expect(advisories.map((a) => a.affectedVersion).sort()).toEqual(["1.0.0", "1.0.1"]);
  });

  it("maps a dependency with no vulnerabilities to no advisories, without a detail fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [{}] }));

    const result = await fetchOsvAdvisories([dep({ name: "jsonwebtoken", version: "9.0.2" })]);

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to null severity when OSV doesn't report one", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ results: [{ vulns: [{ id: "GHSA-x", modified: "2026-01-01T00:00:00Z" }] }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "GHSA-x", summary: "no severity reported", aliases: [] }));

    const [advisory] = await fetchOsvAdvisories([dep()]);

    expect(advisory!.severity).toBeNull();
    expect(advisory!.url).toBeNull();
  });

  it("throws a descriptive error when OSV returns a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, false, 500));

    await expect(fetchOsvAdvisories([dep()])).rejects.toThrow(/querybatch.*500/);
  });
});
