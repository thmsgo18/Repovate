import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findNpmDependencies, findPackageJsonFiles, parseNpmManifest } from "./npm.js";

describe("npm manifest parsing", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "repovate-npm-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function write(relPath: string, content: unknown): Promise<void> {
    const full = path.join(repoRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, JSON.stringify(content), "utf8");
  }

  it("parses a lockfileVersion 3 lockfile: direct vs transitive, exact resolved versions", async () => {
    await write("package.json", {
      dependencies: { express: "^4.18.2" },
      devDependencies: { jest: "^29.7.0" },
    });
    await write("package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { express: "^4.18.2" }, devDependencies: { jest: "^29.7.0" } },
        "node_modules/express": { version: "4.22.1" },
        "node_modules/jest": { version: "29.7.0" },
        // transitive dep of express, not listed in root dependencies/devDependencies
        "node_modules/qs": { version: "6.14.0" },
        // scoped transitive package — name must include the scope
        "node_modules/@babel/core": { version: "7.24.0" },
      },
    });

    const result = await parseNpmManifest(repoRoot, "package.json");

    expect(result.transitiveCoverage).toBe("full");
    expect(result.lockfilePath).toBe("package-lock.json");
    const byName = Object.fromEntries(result.dependencies.map((d) => [d.name, d]));
    expect(byName.express).toEqual({
      name: "express",
      version: "4.22.1",
      ecosystem: "npm",
      direct: true,
      manifestPath: "package.json",
    });
    expect(byName.jest!.direct).toBe(true);
    expect(byName.qs!.direct).toBe(false);
    expect(byName["@babel/core"]).toEqual({
      name: "@babel/core",
      version: "7.24.0",
      ecosystem: "npm",
      direct: false,
      manifestPath: "package.json",
    });
  });

  it("does not mark a nested transitive package as direct just because it shares its name with a real root dependency", async () => {
    // Regression test: found via a real-world run against thmsgo18/Neurovent
    // — sequelize pulls in its own copy of uuid@8.3.2, independent of the
    // root's real direct dependency on uuid@9.0.1.
    await write("package.json", { dependencies: { uuid: "^9.0.1", sequelize: "^6.35.2" } });
    await write("package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { uuid: "^9.0.1", sequelize: "^6.35.2" } },
        "node_modules/uuid": { version: "9.0.1" },
        "node_modules/sequelize": { version: "6.35.2" },
        "node_modules/sequelize/node_modules/uuid": { version: "8.3.2" },
      },
    });

    const result = await parseNpmManifest(repoRoot, "package.json");
    const uuidEntries = result.dependencies.filter((d) => d.name === "uuid");

    expect(uuidEntries).toHaveLength(2);
    const rootUuid = uuidEntries.find((d) => d.version === "9.0.1");
    const nestedUuid = uuidEntries.find((d) => d.version === "8.3.2");
    expect(rootUuid?.direct).toBe(true);
    expect(nestedUuid?.direct).toBe(false);
  });

  it("parses a lockfileVersion 1 lockfile, including a version-conflicted nested transitive dep", async () => {
    await write("package.json", { dependencies: { express: "^4.17.0" } });
    await write("package-lock.json", {
      lockfileVersion: 1,
      dependencies: {
        express: {
          version: "4.17.1",
          requires: { qs: "6.7.0" },
          dependencies: {
            // a nested, version-conflicted copy of qs scoped under express
            qs: { version: "6.7.0" },
          },
        },
        // a top-level qs at a different (newer) version
        qs: { version: "6.9.6" },
      },
    });

    const result = await parseNpmManifest(repoRoot, "package.json");

    expect(result.transitiveCoverage).toBe("full");
    const qsEntries = result.dependencies.filter((d) => d.name === "qs");
    expect(qsEntries).toHaveLength(2);
    expect(qsEntries.every((d) => d.direct === false)).toBe(true);
    expect(qsEntries.map((d) => d.version).sort()).toEqual(["6.7.0", "6.9.6"]);

    const express = result.dependencies.find((d) => d.name === "express");
    expect(express?.direct).toBe(true);
    expect(express?.version).toBe("4.17.1");
  });

  it("falls back to direct-only, range-approximated versions when there is no lockfile", async () => {
    await write("package.json", {
      dependencies: { express: "^4.18.2", left: "~1.2.3" },
      devDependencies: { jest: ">=29.0.0" },
    });

    const result = await parseNpmManifest(repoRoot, "package.json");

    expect(result.transitiveCoverage).toBe("direct-only");
    expect(result.lockfilePath).toBeNull();
    const byName = Object.fromEntries(result.dependencies.map((d) => [d.name, d]));
    expect(byName.express!.version).toBe("4.18.2");
    expect(byName.left!.version).toBe("1.2.3");
    expect(byName.jest!.version).toBe("29.0.0");
    expect(result.dependencies.every((d) => d.direct)).toBe(true);
  });

  it("discovers every package.json in a monorepo, skipping node_modules", async () => {
    await write("package.json", { dependencies: {} });
    await write("frontend-react/package.json", { dependencies: {} });
    await write("backend-node/package.json", { dependencies: {} });
    await write("backend-node/node_modules/some-dep/package.json", { dependencies: {} });

    const found = await findPackageJsonFiles(repoRoot);

    expect(found.sort()).toEqual(["backend-node/package.json", "frontend-react/package.json", "package.json"].sort());
  });

  it("findNpmDependencies parses every manifest found in a monorepo", async () => {
    await write("frontend-react/package.json", { dependencies: { react: "^19.0.0" } });
    await write("backend-node/package.json", { dependencies: { express: "^4.18.2" } });
    await write("backend-node/package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { express: "^4.18.2" } },
        "node_modules/express": { version: "4.22.1" },
      },
    });

    const results = await findNpmDependencies(repoRoot);

    expect(results).toHaveLength(2);
    const backend = results.find((r) => r.manifestPath === "backend-node/package.json");
    const frontend = results.find((r) => r.manifestPath === "frontend-react/package.json");
    expect(backend?.transitiveCoverage).toBe("full");
    expect(frontend?.transitiveCoverage).toBe("direct-only");
  });
});
