#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import "./detectors/index.js";
import { ImportError } from "./errors.js";
import { formatPlan } from "./format.js";
import { buildPlan } from "./plan.js";
import { applyWrites, manifestRelPath, planWrites } from "./write.js";

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} (Y/n) `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

const program = new Command("tdk-import")
  .version(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version)
  .description("Import services from the root docker-compose.yml into TDK")
  .argument("[dir]", "Directory containing docker-compose.yml", ".")
  .option("--dry-run", "Print the plan and write nothing", false)
  .option("--yes", "Write without prompting", false)
  .option("--force", "Overwrite an existing service.json", false)
  .action(async (dir: string, options) => {
    const plan = buildPlan(dir);
    const writes = planWrites(plan, options.force);

    console.log(formatPlan(plan, writes));

    const pending = writes.items.filter((i) => i.status !== "exists");
    if (plan.services.length === 0) {
      return void console.log("Nothing to import.");
    }
    if (options.dryRun) return void console.log("Dry run: nothing written.");
    if (pending.length === 0 && !writes.projectConfig) {
      return void console.log("Nothing to write: every service.json already exists.");
    }
    if (
      !options.yes &&
      !(await confirm(
        `Write ${pending.length} service.json file(s)${writes.projectConfig ? " and create .tdk/project.json" : ""}?`,
      ))
    )
      return;
    const written = applyWrites(writes);
    for (const item of written) {
      console.log(`  wrote ${relative(process.cwd(), item.path) || manifestRelPath(plan, item)}`);
    }
    console.log(
      `\nWrote ${written.length} service.json file(s)${writes.projectConfig ? " and created .tdk/project.json" : ""}.`,
    );
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof ImportError) for (const s of err.suggestions) console.error(`  -> ${s}`);
  process.exit(err instanceof ImportError && err.exitCode ? err.exitCode : 1);
}
