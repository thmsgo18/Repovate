import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.js";

describe("readJsonFile / writeJsonFile", () => {
  let dir: string;
  const schema = z.object({ n: z.number() });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "repovate-jsonfile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", async () => {
    expect(await readJsonFile(path.join(dir, "missing.json"), schema)).toBeNull();
  });

  it("round-trips through write then read", async () => {
    const filePath = path.join(dir, "nested", "value.json");
    await writeJsonFile(filePath, schema, { n: 42 });
    expect(await readJsonFile(filePath, schema)).toEqual({ n: 42 });
  });

  it("names the offending file when the JSON is malformed — a cron run has no one to ask", async () => {
    const filePath = path.join(dir, "corrupt.json");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, "{ not valid json", "utf8");
    await expect(readJsonFile(filePath, schema)).rejects.toThrow(filePath);
  });

  it("still throws a schema validation error when JSON is valid but shaped wrong", async () => {
    const filePath = path.join(dir, "wrong-shape.json");
    await writeFile(filePath, JSON.stringify({ n: "not a number" }), "utf8");
    await expect(readJsonFile(filePath, schema)).rejects.toThrow();
  });
});
