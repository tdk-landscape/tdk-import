import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPlan } from "../format.js";
import { buildPlan } from "../plan.js";
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
  root = join(mkdtempSync(join(tmpdir(), "tdk-import-")), "shop");
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

const serviceJson = (name: string) => join(root, "services", "shop", name, "service.json");

describe("root Compose import", () => {
  const compose = [
    "services:",
    "  api:",
    "    build:",
    "      context: ./api",
    "      dockerfile: Dockerfile",
    "    ports: ['4000:4000']",
    "    environment:",
    "      DATABASE_URL: postgres://user:secret@db/app",
    "    depends_on: [db]",
    "    healthcheck:",
    "      test: ['CMD-SHELL', 'curl -f http://localhost:4000/health || exit 1']",
    "  db:",
    "    image: example.invalid/database:latest",
    "    ports: ['5432:5432']",
  ].join("\n");

  it("reads only root docker-compose.yml and plans one entry per Compose service", () => {
    tree({
      "docker-compose.yml": compose,
      "nested/docker-compose.yml": "services:\n  ignored:\n    image: nginx\n",
      "api/Dockerfile": "FROM node:22\n",
      "package.json": '{"scripts":{"start":"node app.js"}}',
      Procfile: "web: node app.js\n",
    });
    const plan = buildPlan(root);
    expect(plan.files).toEqual(["docker-compose.yml"]);
    expect(plan.services.map((s) => s.name).sort()).toEqual(["api", "db"]);
    expect(plan.services.find((s) => s.name === "api")).toMatchObject({
      dir: "api",
      dockerfile: "Dockerfile",
      port: 4000,
      healthCheckPath: "/health",
      dependsOn: ["db"],
    });
    expect(plan.services.map((s) => s.name)).not.toContain("ignored");
  });

  it("prints a plan without writing and writes manifests plus project config only when applied", () => {
    tree({ "docker-compose.yml": compose });
    const plan = buildPlan(root);
    const writes = planWrites(plan, false);
    expect(formatPlan(plan, writes)).toContain("depends:   db");
    expect(formatPlan(plan, writes)).toContain(".tdk/project.json  [create TDK project]");
    expect(existsSync(join(root, "services"))).toBe(false);
    expect(existsSync(join(root, ".tdk"))).toBe(false);

    applyWrites(writes);
    const api = JSON.parse(readFileSync(serviceJson("api"), "utf8"));
    const db = JSON.parse(readFileSync(serviceJson("db"), "utf8"));
    expect(api).toMatchObject({
      stack: "shop",
      appType: "bring-your-own",
      port: 4000,
      healthCheckPath: "/health",
      dependsOn: ["db"],
      buildContext: "../../../api",
      dockerfile: "Dockerfile",
    });
    expect(db).toMatchObject({
      image: "example.invalid/database:latest",
      appType: "worker",
      port: 5432,
    });
    expect(readFileSync(serviceJson("api"), "utf8")).not.toContain("postgres://");
    expect(
      JSON.parse(readFileSync(join(root, ".tdk", "project.json"), "utf8")).phases.pre_alpha
        .enabledStacks,
    ).toContain("shop");
  });

  it("never overwrites existing service.json without force", () => {
    tree({ "docker-compose.yml": compose });
    const file = serviceJson("api");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"userOwned":true}\n');
    const writes = planWrites(buildPlan(root), false);
    expect(writes.items.find((i) => i.service.name === "api")?.status).toBe("exists");
    applyWrites(writes);
    expect(readFileSync(file, "utf8")).toBe('{"userOwned":true}\n');
  });

  it("refuses a missing root docker-compose.yml instead of walking for other inputs", () => {
    tree({
      "nested/docker-compose.yml": compose,
      Dockerfile: "FROM nginx\n",
      "package.json": '{"scripts":{"start":"node app.js"}}',
    });
    expect(() => buildPlan(root)).toThrow(/No root docker-compose.yml found/);
  });
});
