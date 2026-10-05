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

// Runs the built binary (dist/cli.js) as a user would, against a copy of a fixture repo.
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
  // node_modules is gitignored, so the fixture ships under another name and is copied into place.
  cpSync(
    join(import.meta.dirname, "fixtures", "node_modules-fixture"),
    join(repo, "node_modules"),
    {
      recursive: true,
    },
  );
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("tdk-import (built CLI)", () => {
  it("--dry-run prints the merged plan and writes nothing", () => {
    const r = run(["shop", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Found 4 service(s) and 1 job(s)");
    expect(r.out).toMatch(
      /api {2}\(service, api\/\)[\s\S]*docker-compose\.yml \[compose\], api\/Dockerfile \[dockerfile\], api\/package\.json \[package-json\]/,
    );
    expect(r.out).toContain("Procfile:4 [procfile]: not a `name: command` line");
    expect(r.out).not.toContain("left-pad");
    expect(r.out).toContain("Dry run: nothing written.");
    expect(existsSync(join(repo, "services"))).toBe(false);
  });

  it("--yes writes one manifest per service, never env values", () => {
    const r = run(["shop", "--yes"]);
    expect(r.code).toBe(0);
    expect(manifest("api")).toMatchObject({
      appType: "bring-your-own",
      stack: "shop",
      dependsOn: ["db"],
      buildContext: "../../../api",
      dockerfile: "Dockerfile",
    });
    expect(manifest("db").image).toBe("postgres:16");
    expect(manifest("release")).toMatchObject({ restart: "no", exposeViaProxy: false });
    expect(
      readFileSync(join(repo, "services", "shop", "api", "service.json"), "utf8"),
    ).not.toContain("secret");
    const ports = ["api", "db", "release", "web", "worker"].map((n) => manifest(n).port);
    expect(new Set(ports).size).toBe(5);
  });

  it("re-run keeps existing files; --force rewrites identical files", () => {
    run(["shop", "--yes"]);
    const before = readFileSync(join(repo, "services", "shop", "web", "service.json"), "utf8");
    writeFileSync(join(repo, "services", "shop", "web", "service.json"), '{"mine":true}\n');
    const kept = run(["shop", "--yes"]);
    expect(kept.out).toContain("Nothing to write: every service.json already exists.");
    expect(readFileSync(join(repo, "services", "shop", "web", "service.json"), "utf8")).toBe(
      '{"mine":true}\n',
    );
    run(["shop", "--yes", "--force"]);
    expect(readFileSync(join(repo, "services", "shop", "web", "service.json"), "utf8")).toBe(
      before,
    );
  });

  it("prompts without --yes: 'n' writes nothing, 'y' writes", () => {
    expect(run(["shop"], "n\n").code).toBe(0);
    expect(existsSync(join(repo, "services"))).toBe(false);
    run(["shop"], "y\n");
    expect(existsSync(join(repo, "services", "shop", "web", "service.json"))).toBe(true);
  });

  it("--only limits detectors; unknown id exits 1 and writes nothing", () => {
    const only = run(["shop", "--only", "procfile", "--dry-run"]);
    expect(only.out).toContain("Found 2 service(s) and 1 job(s)");
    const bad = run(["shop", "--only", "procfile,helm", "--yes"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Unknown import detector: helm");
    expect(bad.err).toContain("compose, dockerfile, package-json, procfile");
    expect(existsSync(join(repo, "services"))).toBe(false);
  });

  it("exits 1 for a directory that does not exist", () => {
    const r = run(["nope", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a directory");
  });

  it("refuses a Helm-only directory: exit 2, names Helm, writes nothing", () => {
    const helm = join(work, "chart");
    cpSync(join(import.meta.dirname, "fixtures", "helm-only"), helm, { recursive: true });
    const r = run(["chart"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Helm is not imported");
    expect(r.out).toContain("Chart.yaml [unsupported]: Helm is not imported");
    expect(existsSync(join(helm, "services"))).toBe(false);
  });

  it("refuses Helm-only input in dry-run without printing a plan", () => {
    const helm = join(work, "helm-dry-run");
    mkdirSync(helm);
    writeFileSync(join(helm, "Chart.yaml"), "apiVersion: v2\n");
    const r = run(["helm-dry-run", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Chart.yaml [unsupported]: Helm is not imported");
    expect(r.err).toContain("Helm is not imported");
    expect(r.out).not.toContain("Found ");
    expect(existsSync(join(helm, "services"))).toBe(false);
  });

  it("refuses Kustomize-only input normally and in dry-run without printing a plan", () => {
    const kustomize = join(work, "kustomize");
    mkdirSync(kustomize);
    writeFileSync(join(kustomize, "kustomization.yaml"), "resources: []\n");
    const normal = run(["kustomize"]);
    expect(normal.code).toBe(2);
    expect(normal.err).toContain("Kustomize is not imported");
    expect(normal.out).not.toContain("Found ");

    const r = run(["kustomize", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("kustomization.yaml [unsupported]: Kustomize is not imported");
    expect(r.err).toContain("Kustomize is not imported");
    expect(r.out).not.toContain("Found ");
    expect(existsSync(join(kustomize, "services"))).toBe(false);
  });

  it("imports a Node Procfile sibling and skips Python with exit 0", () => {
    const mixed = join(work, "mixed");
    mkdirSync(mixed);
    writeFileSync(join(mixed, "Procfile"), "web: python app.py\nworker: node worker.js\n");
    const r = run(["mixed", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('process "web" skipped');
    expect(existsSync(join(mixed, "services", "mixed", "worker", "service.json"))).toBe(true);
    expect(existsSync(join(mixed, "services", "mixed", "web", "service.json"))).toBe(false);
  });

  it("exits 2 without writes when every valid Procfile process is skipped", () => {
    const skipped = join(work, "skipped");
    mkdirSync(skipped);
    writeFileSync(join(skipped, "Procfile"), "web: python app.py\nworker: ruby worker.rb\n");
    const r = run(["skipped", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('process "web" skipped');
    expect(r.out).toContain('process "worker" skipped');
    expect(r.out).not.toContain("Found ");
    expect(existsSync(join(skipped, "services"))).toBe(false);
  });

  it("lists Helm as skipped but still imports Compose when both exist", () => {
    cpSync(
      join(import.meta.dirname, "fixtures", "helm-only", "Chart.yaml"),
      join(repo, "Chart.yaml"),
    );
    const r = run(["shop", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Chart.yaml [unsupported]: Helm is not imported");
    expect(existsSync(join(repo, "services", "shop", "api", "service.json"))).toBe(true);
  });

  it.each([
    {
      dir: "compose-mixed",
      unsupported: "Chart.yaml",
      input: "docker-compose.yml",
      content: "services:\n  api:\n    image: busybox\n",
      service: "api",
    },
    {
      dir: "dockerfile-mixed",
      unsupported: "kustomization.yaml",
      input: "Dockerfile",
      content: "FROM busybox\n",
      service: "dockerfile-mixed",
    },
    {
      dir: "package-mixed",
      unsupported: "Chart.yaml",
      input: "package.json",
      content: '{"scripts":{"start":"node app.js"}}',
      service: "package-mixed",
    },
    {
      dir: "procfile-mixed",
      unsupported: "kustomization.yaml",
      input: "Procfile",
      content: "web: node app.js\n",
      service: "web",
    },
  ])("writes the $service service when $input appears beside unsupported input", (scenario) => {
    const root = join(work, scenario.dir);
    mkdirSync(root);
    writeFileSync(join(root, scenario.unsupported), "resources: []\n");
    writeFileSync(join(root, scenario.input), scenario.content);
    const r = run([scenario.dir, "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "services", scenario.dir, scenario.service, "service.json"))).toBe(
      true,
    );
  });
});
