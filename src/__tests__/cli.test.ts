import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reports the package version without importing a directory", () => {
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(pkg.version);
  expect(result.stderr).toBe("");
});
