import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlan } from "../plan.js";
import { detectorIds, selectDetectors } from "../registry.js";
import { isNodeCommand } from "../scaffold.js";
import { scanTree } from "../scan.js";
import { applyWrites, planWrites } from "../write.js";

let root: string;

function tree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

beforeEach(() => {
  // A sub-directory gives a stable stack name ("shop") whatever mkdtemp returns.
  root = join(mkdtempSync(join(tmpdir(), "tdk-import-")), "shop");
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

const serviceJson = (name: string) => join(root, "services", "shop", name, "service.json");

describe("registry and scan", () => {
  it("registers the four first detectors in precedence order", () => {
    buildPlan(root);
    expect(detectorIds()).toEqual(["compose", "dockerfile", "package-json", "procfile"]);
  });

  it("fails an unknown --only id before walking, naming the registered ids", () => {
    buildPlan(root);
    expect(() => selectDetectors(["procfile", "helm"])).toThrow(/Unknown import detector: helm/);
    expect(() => buildPlan(root, ["helm"])).toThrow();
  });

  it("skips node_modules and .gitignore'd paths but keeps the root Procfile", () => {
    tree({
      Procfile: "web: npm start\n",
      "node_modules/left-pad/package.json": '{"scripts":{"start":"node x.js"}}',
      "build-out/Procfile": "web: nope\n",
      ".gitignore": "build-out/\n*.log\n!keep.log\n",
      "a.log": "",
    });
    const scan = scanTree(root);
    expect(scan.files).toContain("Procfile");
    expect(scan.files).not.toContain("node_modules/left-pad/package.json");
    expect(scan.files).not.toContain("build-out/Procfile");
    expect(scan.files).not.toContain("a.log");
    expect(scan.notes.join()).toContain("negation");
    expect(buildPlan(root).services.map((s) => s.name)).toEqual(["web"]);
  });

  it("caps files and says so", () => {
    tree({ "a.txt": "", "b.txt": "", "c.txt": "" });
    const scan = scanTree(root, { depth: 8, files: 2 });
    expect(scan.files).toHaveLength(2);
    expect(scan.notes.join()).toContain("stopped after 2 files");
  });
});

describe("unsupported formats beside supported importers", () => {
  it.each([
    ["Compose", { "docker-compose.yml": "services:\n  api:\n    image: busybox\n" }, "api"],
    ["Dockerfile", { Dockerfile: "FROM busybox\n" }, "shop"],
    ["package.json script", { "package.json": '{"scripts":{"start":"node app.js"}}' }, "shop"],
    ["Procfile", { Procfile: "web: node app.js\n" }, "web"],
  ])(
    "keeps the %s import when unsupported files are present",
    (_label, supported, expectedName) => {
      tree({
        "Chart.yaml": "apiVersion: v2\n",
        "kustomization.yaml": "resources: []\n",
        ...supported,
      });
      const plan = buildPlan(root);
      expect(plan.services.map((service) => service.name)).toContain(expectedName);
      expect(plan.unsupported).toEqual(["Helm", "Kustomize"]);
      expect(planWrites(plan, false).items.map((item) => item.service.name)).toContain(
        expectedName,
      );
    },
  );

  it.each([
    ["Helm", { "Chart.yaml": "apiVersion: v2\n" }],
    ["Kustomize", { "kustomization.yaml": "resources: []\n" }],
  ])("reports %s as unsupported-only input", (_label, files) => {
    tree(files);
    const plan = buildPlan(root);
    expect(plan.services).toEqual([]);
    expect(plan.unsupported).toEqual([_label]);
    expect(planWrites(plan, false).items).toEqual([]);
  });
});

describe("Procfile command classification", () => {
  it.each(["node app.js", "npm start", "pnpm run dev", "yarn start", "bun app.ts"])(
    "accepts the explicit Node/Bun prefix %s",
    (command) => expect(isNodeCommand(command)).toBe(true),
  );

  it.each(["python app.py", "ruby app.rb", "gunicorn app:app", "poetry run server", "npx app"])(
    "does not guess that %s is a supported command",
    (command) => expect(isNodeCommand(command)).toBe(false),
  );

  it("imports a Node process while skipping an unbuildable Python sibling", () => {
    tree({ Procfile: "web: python app.py\nworker: node worker.js\n" });
    const plan = buildPlan(root);
    expect(plan.services.map((service) => service.name)).toEqual(["worker"]);
    expect(plan.skippedProcfileProcesses).toBe(1);
    expect(plan.skips.some((skip) => skip.reason.includes('process "web" skipped'))).toBe(true);

    applyWrites(planWrites(plan, false));
    expect(existsSync(serviceJson("worker"))).toBe(true);
    expect(existsSync(serviceJson("web"))).toBe(false);
  });

  it("keeps a non-Node Procfile process when a matching image is available", () => {
    tree({
      Procfile: "web: python app.py\n",
      "docker-compose.yml": "services:\n  web:\n    image: python:3.12\n",
    });
    const plan = buildPlan(root);
    expect(plan.services.map((service) => service.name)).toEqual(["web"]);
    expect(plan.services[0]?.image).toBe("python:3.12");
    expect(plan.skippedProcfileProcesses).toBe(0);
  });

  it("keeps a non-Node Procfile process when a matching Dockerfile is available", () => {
    tree({ Procfile: "web: python app.py\n", Dockerfile: "FROM python:3.12\n" });
    const plan = buildPlan(root);
    expect(plan.services.map((service) => service.name)).toEqual(["web"]);
    expect(plan.services[0]?.dockerfile).toBe("Dockerfile");
    expect(plan.skippedProcfileProcesses).toBe(0);
  });

  it("records when every valid process was skipped", () => {
    tree({ Procfile: "web: python app.py\nworker: ruby worker.rb\n" });
    const plan = buildPlan(root);
    expect(plan.services).toEqual([]);
    expect(plan.skippedProcfileProcesses).toBe(2);
    expect(planWrites(plan, false).items).toEqual([]);
  });
});

describe("procfile detector (#520)", () => {
  const procfile = [
    "# comment",
    "web: bundle exec puma -C config/puma.rb",
    "worker: node worker.js",
    "release: npm run migrate",
    "garbage line",
    "empty:",
    "",
  ].join("\n");

  it("imports supported commands and skips unbuildable processes, preserving malformed line numbers", () => {
    tree({ Procfile: procfile });
    const plan = buildPlan(root);
    expect(plan.services.map((s) => [s.name, s.kind])).toEqual([
      ["release", "job"],
      ["worker", "service"],
    ]);
    expect(plan.services.every((s) => s.sources[0]?.file === "Procfile")).toBe(true);
    expect(plan.services.every((s) => s.port === undefined)).toBe(true);
    expect(plan.skips.map((s) => s.line).filter((line) => line !== undefined)).toEqual([5, 6]);
    expect(plan.skips.some((s) => s.reason.includes('process "web" skipped'))).toBe(true);
  });

  it("keeps supported process manifests available to the writer", () => {
    tree({ Procfile: procfile });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    expect(writes.items).toHaveLength(2);
    expect(existsSync(join(root, "services"))).toBe(false);

    applyWrites(writes);
    expect(JSON.parse(readFileSync(serviceJson("worker"), "utf8")).port).toBe(4001);
    expect(JSON.parse(readFileSync(serviceJson("release"), "utf8"))).toMatchObject({
      restart: "no",
      exposeViaProxy: false,
    });
  });

  it("keeps an existing service.json unless --force, and is idempotent with --force", () => {
    tree({ Procfile: "web: npm start\n" });
    applyWrites(planWrites(buildPlan(root), false));
    const before = readFileSync(serviceJson("web"), "utf8");
    writeFileSync(serviceJson("web"), '{"mine":true}\n');

    const kept = planWrites(buildPlan(root), false);
    expect(kept.items[0]?.status).toBe("exists");
    applyWrites(kept);
    expect(readFileSync(serviceJson("web"), "utf8")).toBe('{"mine":true}\n');

    writeFileSync(serviceJson("web"), before);
    applyWrites(planWrites(buildPlan(root), true));
    expect(readFileSync(serviceJson("web"), "utf8")).toBe(before);
    applyWrites(planWrites(buildPlan(root), true));
    expect(readFileSync(serviceJson("web"), "utf8")).toBe(before);
  });

  it("lists a conflict when Procfile and Procfile.dev disagree", () => {
    tree({ Procfile: "web: npm start\n", "Procfile.dev": "web: npm run dev\n" });
    const [web] = buildPlan(root).services;
    expect(web?.command).toBeUndefined();
    expect(web?.conflicts[0]?.field).toBe("command");
  });
});

describe("merge across files", () => {
  const compose = [
    "services:",
    "  api:",
    "    build: ./api",
    "    ports: ['8080:3000']",
    "    environment:",
    "      DB_URL: postgres://x",
    "    depends_on: [db]",
    "  db:",
    "    image: postgres:16",
    "    ports: ['5432:5432']",
  ].join("\n");

  it("merges Compose, Dockerfile and package.json into one api service", () => {
    tree({
      "docker-compose.yml": compose,
      "api/Dockerfile": 'FROM oven/bun:1\nEXPOSE 3000\nCMD ["bun", "src/index.ts"]\n',
      "api/package.json": '{"scripts":{"start":"bun src/index.ts"}}',
      "package.json": '{"scripts":{"dev":"turbo dev"}}',
    });
    const plan = buildPlan(root);
    const api = plan.services.find((s) => s.name === "api");
    expect(plan.services.filter((s) => s.name === "api")).toHaveLength(1);
    expect(api?.sources.map((s) => s.file).sort()).toEqual([
      "api/Dockerfile",
      "api/package.json",
      "docker-compose.yml",
    ]);
    expect(api?.port).toBe(3000);
    expect(api?.command).toBe("bun src/index.ts");
    expect(api?.language).toBe("bun");
    expect(api?.envKeys).toEqual(["DB_URL"]);
    expect(api?.dependsOn).toEqual(["db"]);
    // the root package.json must not be attached to the image-only `db`
    const db = plan.services.find((s) => s.name === "db");
    expect(db?.sources.map((s) => s.file)).toEqual(["docker-compose.yml"]);
    expect(plan.services.map((s) => s.name).sort()).toEqual(["api", "db", "shop"]);

    const writes = planWrites(plan, false);
    applyWrites(writes);
    const manifest = JSON.parse(readFileSync(serviceJson("api"), "utf8"));
    expect(manifest.dependsOn).toEqual(["db"]);
    expect(JSON.parse(readFileSync(serviceJson("db"), "utf8")).image).toBe("postgres:16");
    expect(JSON.stringify(manifest)).not.toContain("postgres://");
  });

  it("fills a command Compose did not set from the Dockerfile CMD", () => {
    tree({
      "docker-compose.yml": "services:\n  api:\n    build: ./api\n",
      "api/Dockerfile": "FROM node:22\nCMD node server.js\n",
    });
    const [api] = buildPlan(root).services;
    expect(api?.command).toBe("node server.js");
    expect(api?.sources).toHaveLength(2);
  });

  it("reports a port conflict, omits the field, and keeps the rest", () => {
    tree({
      "docker-compose.yml": "services:\n  api:\n    build: ./api\n    ports: ['8080']\n",
      "api/Dockerfile": "FROM node:22\nEXPOSE 3000\nCMD node server.js\n",
    });
    const plan = buildPlan(root);
    const [api] = plan.services;
    expect(api?.port).toBeUndefined();
    expect(api?.conflicts).toHaveLength(1);
    expect(api?.conflicts[0]?.values.map((v) => v.value).sort()).toEqual(["3000", "8080"]);
    expect(api?.command).toBe("node server.js");
    const [item] = planWrites(plan, false).items;
    expect(item?.manifest.port).toBe(4000);
    expect(item?.manifest.buildContext).toBe("../../../api");
    expect(item?.manifest.dockerfile).toBe("Dockerfile");
  });

  it("uses an agreed in-range port and a free TDK port otherwise", () => {
    tree({
      "docker-compose.yml":
        "services:\n  a:\n    image: x\n    ports: ['4500']\n  b:\n    image: y\n    ports: ['4500']\n",
    });
    const items = planWrites(buildPlan(root), false).items;
    expect(items.map((i) => i.manifest.port)).toEqual([4500, 4000]);
  });

  it("does not guess when a directory has several named services", () => {
    tree({
      Procfile: "web: node a.js\nworker: node b.js\n",
      "package.json": '{"scripts":{"start":"node a.js"}}',
    });
    const plan = buildPlan(root);
    expect(plan.services.map((s) => s.name)).toEqual(["web", "worker"]);
    expect(
      plan.skips.some((s) => s.file === "package.json" && /several services/.test(s.reason)),
    ).toBe(true);
  });

  it("names unsupported Compose features and still lists readable services", () => {
    tree({
      "docker-compose.yml": [
        "x-common: &common",
        "  image: busybox",
        "services:",
        "  base:",
        "    <<: *common",
        "  child:",
        "    extends: { service: base }",
        "  tools:",
        "    image: busybox",
        "    profiles: [debug]",
        "  ok:",
        "    image: nginx",
        "    ports: ['80', '443']",
      ].join("\n"),
    });
    const plan = buildPlan(root);
    expect(plan.services.map((s) => s.name).sort()).toEqual(["base", "ok"]);
    const reasons = plan.skips.map((s) => s.reason).join("\n");
    expect(reasons).toMatch(/anchors/);
    expect(reasons).toMatch(/"child" uses `extends`/);
    expect(reasons).toMatch(/"tools" uses `profiles`/);
    expect(reasons).toMatch(/several ports \(80, 443\)/);
    expect(plan.services.find((s) => s.name === "base")?.image).toBe("busybox");
  });

  it("sets a language only for an obvious bun or node script", () => {
    tree({
      "a/package.json": '{"scripts":{"start":"NODE_ENV=production node index.js"}}',
      "b/package.json": '{"scripts":{"start":"npm run serve"}}',
      "c/package.json": '{"name":"lib"}',
    });
    const plan = buildPlan(root);
    expect(plan.services.map((s) => [s.name, s.language])).toEqual([
      ["a", "node"],
      ["b", undefined],
    ]);
    expect(plan.skips.some((s) => s.file === "c/package.json")).toBe(true);
  });
});

describe("ports", () => {
  it("does not hand a kept manifest's port to a new service", () => {
    tree({ Procfile: "web: node a.js\nworker: node b.js\n" });
    mkdirSync(dirname(serviceJson("web")), { recursive: true });
    writeFileSync(serviceJson("web"), '{"port":4000}\n');
    const items = planWrites(buildPlan(root), false).items;
    expect(items.find((i) => i.service.name === "web")?.status).toBe("exists");
    expect(items.find((i) => i.service.name === "worker")?.manifest.port).toBe(4001);
  });
});

describe("runnable output", () => {
  it("scaffolds a Dockerfile for a Node/Bun Procfile command, building from the source dir", () => {
    tree({ Procfile: "web: npm start\nworker: python worker.py\n" });
    const items = planWrites(buildPlan(root), false).items;
    const web = items.find((i) => i.service.name === "web");
    expect(web?.manifest).toMatchObject({
      buildContext: "../../..",
      dockerfile: "./services/shop/web/Dockerfile",
    });
    expect(web?.extraFiles[0]?.content).toContain("FROM node:22-alpine");
    expect(web?.extraFiles[1]?.path).toMatch(/Dockerfile\.dockerignore$/);
    expect(web?.extraFiles[1]?.content).toContain(".env");
    expect(web?.extraFiles[0]?.content).toContain('CMD ["sh", "-c", "npm start"]');
    // a runtime we cannot build for is not guessed
    const worker = items.find((i) => i.service.name === "worker");
    expect(worker).toBeUndefined();
    applyWrites(planWrites(buildPlan(root), false));
    expect(existsSync(join(root, "services", "shop", "web", "Dockerfile"))).toBe(true);
    expect(existsSync(join(root, "services", "shop", "worker", "Dockerfile"))).toBe(false);
    expect(existsSync(serviceJson("worker"))).toBe(false);
  });

  it("does not re-import its own output or a TDK project's services/", () => {
    tree({ Procfile: "web: npm start\n" });
    applyWrites(planWrites(buildPlan(root), false));
    const again = buildPlan(root);
    expect(again.services.map((s) => s.name)).toEqual(["web"]);
    expect(again.notes.join()).toContain("already TDK services");

    tree({
      ".tdk/project.json": "{}",
      "services/platform/db/docker-compose.yml": "services:\n  postgres:\n    image: postgres:16\n",
    });
    const project = buildPlan(root);
    expect(project.services.map((s) => s.name)).toEqual(["web"]);
    expect(project.notes.join()).toContain("TDK project detected");
  });
});
