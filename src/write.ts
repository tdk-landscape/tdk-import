import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ImportError } from "./errors.js";
import { type MergedService, toResourceName } from "./merge.js";
import { type ImportPlan, usedManifestPorts } from "./plan.js";
import { SCAFFOLD_DOCKERIGNORE, scaffoldDockerfile } from "./scaffold.js";
import {
  BYO_PORT_RANGE,
  findProjectRoot,
  SERVICE_MANIFEST_SCHEMA_URL,
  SERVICE_MANIFEST_SCHEMA_VERSION,
  validateName,
} from "./tdk.js";

export type WriteStatus = "create" | "overwrite" | "exists";

export interface WriteItem {
  service: MergedService;
  path: string;
  manifest: Record<string, unknown>;
  status: WriteStatus;
  notes: string[];
  /** Files written next to the manifest (a scaffolded Dockerfile). */
  extraFiles: { path: string; content: string }[];
}

export interface WritePlan {
  stack: string;
  items: WriteItem[];
  projectConfig?: { path: string; content: string };
  /** Services that could not be written, with the reason. */
  rejected: { name: string; reason: string }[];
}

const HTTP_RANGE = { ...BYO_PORT_RANGE, base: BYO_PORT_RANGE.min, range: BYO_PORT_RANGE.label };
const WORKER_RANGE = { min: 6000, max: 6999, base: 6000, range: "6000-6999" };

function existingPort(path: string): number | undefined {
  try {
    const port = JSON.parse(readFileSync(path, "utf8")).port;
    return typeof port === "number" ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps merged services onto TDK bring-your-own manifests. This is the only stage that knows the
 * layout `<project>/services/<stack>/<name>/service.json`. Nothing is written here.
 */
export function planWrites(plan: ImportPlan, force: boolean): WritePlan {
  const projectRoot = findProjectRoot(plan.root) ?? plan.root;
  const stack = toResourceName(basename(plan.root));
  const stackCheck = validateName("Stack name", stack);
  if (!stackCheck.valid) {
    throw new ImportError(`Cannot derive a stack name from "${basename(plan.root)}"`, [
      "Run import from a directory whose name has letters or digits",
    ]);
  }
  const servicesDir = join(projectRoot, "services");
  const projectConfigPath = join(projectRoot, ".tdk", "project.json");
  const projectConfig = existsSync(projectConfigPath)
    ? undefined
    : {
        path: projectConfigPath,
        content: `${JSON.stringify(
          {
            version: "1.0",
            project: { name: basename(projectRoot), version: "1.0.0" },
            phases: {
              pre_alpha: {
                name: "Pre-Alpha",
                description: "TDK proxy and imported Compose services",
                enabledStacks: ["proxy", stack],
              },
              alpha: { name: "Alpha", description: "", enabledStacks: [] },
              beta: { name: "Beta", description: "", enabledStacks: [] },
              out_of_scope: { name: "Out of Scope", description: "", enabledStacks: [] },
            },
            optional_infra: {
              monitoring: false,
              elk: false,
              debezium: false,
              golden_image: false,
              verdaccio: false,
            },
            discovery: { paths: ["services/*/*"] },
            overrides: {},
          },
          null,
          2,
        )}\n`,
      };
  const used = usedManifestPorts(servicesDir);
  const names = new Set(plan.services.map((s) => s.name));
  const items: WriteItem[] = [];
  const rejected: WritePlan["rejected"] = [];

  for (const service of plan.services) {
    const check = validateName("Resource name", service.name);
    if (!check.valid) {
      rejected.push({ name: service.name, reason: check.error ?? "invalid name" });
      continue;
    }
    const path = resolve(servicesDir, stack, service.name, "service.json");
    const exists = existsSync(path);
    const status: WriteStatus = !exists ? "create" : force ? "overwrite" : "exists";
    const notes: string[] = [];

    // A file this run replaces does not count against itself; a kept one keeps its port.
    if (status === "overwrite") used.delete(path);
    const keep = status === "overwrite" ? existingPort(path) : undefined;
    const isWorker = service.exposeViaProxy === false;
    const RANGE = isWorker ? WORKER_RANGE : HTTP_RANGE;
    const taken = new Set(used.values());
    const free = (p: number) => p >= RANGE.min && p <= RANGE.max && !taken.has(p);
    let port: number | undefined;
    if (status === "exists") {
      // Never written, so no port is needed; keep the one on disk for the plan.
      port = existingPort(path) ?? RANGE.base;
    } else if (keep !== undefined && free(keep)) {
      port = keep;
    } else if (service.port !== undefined && service.port >= 1024 && service.port <= 65535) {
      port = service.port;
    } else {
      for (let p = RANGE.base; p <= RANGE.max; p++) {
        if (free(p)) {
          port = p;
          break;
        }
      }
      if (service.port !== undefined && (service.port < RANGE.min || service.port > RANGE.max))
        notes.push(
          `kept Compose container port ${service.port}; it is outside TDK's usual ${RANGE.range} allocation range`,
        );
    }
    if (port === undefined) {
      rejected.push({ name: service.name, reason: `no free port in ${RANGE.range}` });
      continue;
    }
    if (status !== "exists") used.set(path, port);

    const dependsOn = service.dependsOn.filter((d) => d !== service.name && names.has(d));
    const dropped = service.dependsOn.filter((d) => d !== service.name && !names.has(d));
    if (dropped.length)
      notes.push(`dependsOn not written, not in this import: ${dropped.join(", ")}`);
    const manifestDir = dirname(path);
    const sourceDir = resolve(plan.root, service.dir);
    const extraFiles: WriteItem["extraFiles"] = [];
    const buildFields: Record<string, string> = {};
    const toContext = (abs: string) => {
      const rel = relative(sourceDir, abs).split("\\").join("/");
      return rel.startsWith(".") ? rel : `./${rel}`;
    };
    if (!service.image) {
      if (service.dockerfile) {
        // Build from the source tree the Dockerfile lives in; dockerfile is relative to that context.
        buildFields.buildContext = relative(manifestDir, sourceDir).split("\\").join("/") || ".";
        buildFields.dockerfile = service.dockerfile;
      } else {
        const scaffold = service.command ? scaffoldDockerfile(service.command) : undefined;
        if (scaffold) {
          extraFiles.push(
            { path: join(manifestDir, "Dockerfile"), content: scaffold },
            { path: join(manifestDir, "Dockerfile.dockerignore"), content: SCAFFOLD_DOCKERIGNORE },
          );
          buildFields.buildContext = relative(manifestDir, sourceDir).split("\\").join("/") || ".";
          buildFields.dockerfile = toContext(join(manifestDir, "Dockerfile"));
          notes.push(
            "no Dockerfile found: scaffolded one from the command (guessed base image); the app must listen on $PORT",
          );
        } else {
          buildFields.dockerfile = "./Dockerfile";
          notes.push("no image or Dockerfile found; add one before `tdk up`");
        }
      }
    }
    if (service.command && !service.dockerfile && extraFiles.length === 0) {
      notes.push("command is kept as dev.command; bring-your-own does not run it");
    }
    if (service.envKeys.length)
      notes.push("environment values are not written; put them in the project .env");

    const manifest: Record<string, unknown> = {
      $schema: SERVICE_MANIFEST_SCHEMA_URL,
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      appName: service.name,
      appType: "bring-your-own",
      stack,
      port,
      ...(!isWorker ? { healthCheckPath: service.healthCheckPath ?? "/" } : {}),
      ...(service.image ? { image: service.image } : buildFields),
      ...(service.exposeViaProxy === false ? { exposeViaProxy: false } : {}),
      ...(isWorker ? { appType: "worker", exposeViaProxy: false } : {}),
      ...(service.kind === "job" ? { restart: "no", exposeViaProxy: false } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(service.command ? { dev: { command: service.command } } : {}),
    };
    items.push({ service, path, manifest, status, notes, extraFiles });
  }
  return { stack, items, projectConfig, rejected };
}

export function applyWrites(writes: WritePlan): WriteItem[] {
  const written: WriteItem[] = [];
  if (writes.projectConfig) {
    mkdirSync(dirname(writes.projectConfig.path), { recursive: true });
    writeFileSync(writes.projectConfig.path, writes.projectConfig.content, { flag: "wx" });
  }
  for (const item of writes.items) {
    if (item.status === "exists") continue;
    mkdirSync(dirname(item.path), { recursive: true });
    writeFileSync(item.path, `${JSON.stringify(item.manifest, null, 2)}\n`);
    for (const extra of item.extraFiles) writeFileSync(extra.path, extra.content);
    written.push(item);
  }
  return written;
}

export function manifestRelPath(plan: ImportPlan, item: WriteItem): string {
  return relative(plan.root, item.path).split("\\").join("/");
}
