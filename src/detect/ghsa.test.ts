import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DependencyRef } from "../manifests/types.js";
import { fetchGhsaAdvisories, findDependabotPr } from "./ghsa.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body } as unknown as Response;
}

function dep(overrides: Partial<DependencyRef> = {}): DependencyRef {
  return { name: "express", version: "4.18.2", ecosystem: "npm", direct: true, manifestPath: "package.json", ...overrides };
}

describe("fetchGhsaAdvisories", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries by package and filters results to versions actually affected", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          securityVulnerabilities: {
            nodes: [
              {
                advisory: {
                  ghsaId: "GHSA-qw6h-vgh9-j6wx",
                  summary: "express vulnerable to XSS via response.redirect()",
                  severity: "LOW",
                  identifiers: [
                    { type: "GHSA", value: "GHSA-qw6h-vgh9-j6wx" },
                    { type: "CVE", value: "CVE-2024-43796" },
                  ],
                  references: [{ url: "https://github.com/expressjs/express/security/advisories/GHSA-qw6h-vgh9-j6wx" }],
                },
                vulnerableVersionRange: "< 4.20.0",
                firstPatchedVersion: { identifier: "4.20.0" },
              },
              {
                // A newer advisory that does NOT affect our installed 4.18.2 — must be filtered out.
                advisory: {
                  ghsaId: "GHSA-newer-one",
                  summary: "affects only 4.21+",
                  severity: "HIGH",
                  identifiers: [{ type: "GHSA", value: "GHSA-newer-one" }],
                  references: [],
                },
                vulnerableVersionRange: ">= 4.21.0, < 4.22.0",
                firstPatchedVersion: { identifier: "4.22.0" },
              },
            ],
          },
        },
      }),
    );

    const advisories = await fetchGhsaAdvisories([dep({ version: "4.18.2" })], "fake-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.headers.authorization).toBe("bearer fake-token");
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody.variables).toEqual({ ecosystem: "NPM", package: "express" });

    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toEqual({
      id: "GHSA-qw6h-vgh9-j6wx",
      aliases: ["CVE-2024-43796"],
      summary: "express vulnerable to XSS via response.redirect()",
      severity: "low",
      package: "express",
      ecosystem: "npm",
      affectedVersion: "4.18.2",
      source: "ghsa",
      url: "https://github.com/expressjs/express/security/advisories/GHSA-qw6h-vgh9-j6wx",
    });
  });

  it("handles a comma-separated multi-clause range correctly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          securityVulnerabilities: {
            nodes: [
              {
                advisory: {
                  ghsaId: "GHSA-range-test",
                  summary: "range test",
                  severity: "MODERATE",
                  identifiers: [],
                  references: [],
                },
                vulnerableVersionRange: ">= 5.0.0, < 5.2.0",
                firstPatchedVersion: { identifier: "5.2.0" },
              },
            ],
          },
        },
      }),
    );

    const inRange = await fetchGhsaAdvisories([dep({ version: "5.1.0" })], "t");
    expect(inRange).toHaveLength(1);
  });

  it("skips a dependency whose ecosystem has no GHSA mapping", async () => {
    const advisories = await fetchGhsaAdvisories([dep({ ecosystem: "npm" as never, name: "x" })].map((d) => ({ ...d, ecosystem: "cargo" as never })), "t");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(advisories).toEqual([]);
  });

  it("throws on a GraphQL error response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: "rate limited" }] }));
    await expect(fetchGhsaAdvisories([dep()], "t")).rejects.toThrow(/rate limited/);
  });

  it("throws a descriptive error on a non-ok HTTP response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 401));
    await expect(fetchGhsaAdvisories([dep()], "t")).rejects.toThrow(/401/);
  });

  it("maps our internal 'pypi' ecosystem to GHSA's 'PIP' — doesn't match OSV's 'PyPI'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { securityVulnerabilities: { nodes: [] } } }));

    await fetchGhsaAdvisories([dep({ name: "django", version: "6.0.2", ecosystem: "pypi" })], "t");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body).variables).toEqual({ ecosystem: "PIP", package: "django" });
  });
});

describe("findDependabotPr", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds an open dependabot PR touching the same package by title", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          number: 5,
          title: "Bump express from 4.18.2 to 4.22.1",
          html_url: "https://github.com/o/r/pull/5",
          head: { ref: "dependabot/npm_and_yarn/express-4.22.1" },
          user: { login: "dependabot[bot]" },
        },
        {
          number: 6,
          title: "Add a feature",
          html_url: "https://github.com/o/r/pull/6",
          head: { ref: "feature/x" },
          user: { login: "thmsgo18" },
        },
      ]),
    );

    const match = await findDependabotPr("o", "r", "express", "t");
    expect(match?.number).toBe(5);
  });

  it("returns null when no dependabot PR matches the package", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          number: 6,
          title: "Add a feature",
          html_url: "https://github.com/o/r/pull/6",
          head: { ref: "feature/x" },
          user: { login: "thmsgo18" },
        },
      ]),
    );
    expect(await findDependabotPr("o", "r", "express", "t")).toBeNull();
  });

  it("ignores a non-dependabot PR that happens to mention the package name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          number: 7,
          title: "Refactor express routes",
          html_url: "https://github.com/o/r/pull/7",
          head: { ref: "refactor/routes" },
          user: { login: "thmsgo18" },
        },
      ]),
    );
    expect(await findDependabotPr("o", "r", "express", "t")).toBeNull();
  });
});
