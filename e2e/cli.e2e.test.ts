import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let work: string;
let repo: string;

function run(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: "utf8", input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const manifest = (name: string) =>
  JSON.parse(readFileSync(join(repo, "services", "shop", name, "service.json"), "utf8"));

beforeAll(() => {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}${build.stderr}`);
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "tdk-import-e2e-"));
  repo = join(work, "shop");
  cpSync(join(import.meta.dirname, "fixtures", "shop"), repo, { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("tdk-import (built CLI)", () => {
  it("--dry-run prints the root Compose plan and writes nothing", () => {
    const r = run(["shop", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Found 2 service(s) and 0 job(s)");
    expect(r.out).toContain("docker-compose.yml [compose]");
    expect(r.out).toContain("depends:   db");
    expect(r.out).toContain("health:    /health");
    expect(r.out).toContain("Dry run: nothing written.");
    expect(existsSync(join(repo, "services"))).toBe(false);
    expect(existsSync(join(repo, ".tdk"))).toBe(false);
  });

  it("--yes writes one manifest per service, dependency wiring, and project setup without env values", () => {
    const r = run(["shop", "--yes"]);
    expect(r.code).toBe(0);
    expect(manifest("api")).toMatchObject({
      appType: "bring-your-own",
      stack: "shop",
      dependsOn: ["db"],
      buildContext: "../../../api",
      dockerfile: "Dockerfile",
      port: 4000,
      healthCheckPath: "/health",
    });
    expect(manifest("db")).toMatchObject({ appType: "worker", exposeViaProxy: false });
    expect(JSON.stringify(manifest("api"))).not.toContain("postgres://");
    expect(existsSync(join(repo, ".tdk", "project.json"))).toBe(true);
  });

  it("asks before writing and does not overwrite existing service.json without --force", () => {
    const file = join(repo, "services", "shop", "api", "service.json");
    mkdirSync(join(repo, "services", "shop", "api"), { recursive: true });
    writeFileSync(file, '{"userOwned":true}\n');
    const no = run(["shop"], "n\n");
    expect(no.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('{"userOwned":true}\n');
    const yes = run(["shop"], "y\n");
    expect(yes.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('{"userOwned":true}\n');
  });

  it("requires the root docker-compose.yml and ignores nested files", () => {
    rmSync(join(repo, "docker-compose.yml"));
    const r = run(["shop", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No root docker-compose.yml found");
    expect(existsSync(join(repo, "services"))).toBe(false);
  });
});
