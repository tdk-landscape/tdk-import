import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ImportError } from "./errors.js";
import { type MergedService, toResourceName } from "./merge.js";
import { type ImportPlan, usedManifestPorts } from "./plan.js";
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
}

export interface WritePlan {
  stack: string;
  items: WriteItem[];
  /** Services that could not be written, with the reason. */
  rejected: { name: string; reason: string }[];
}

const RANGE = { ...BYO_PORT_RANGE, base: BYO_PORT_RANGE.min, range: BYO_PORT_RANGE.label };

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

    // A file this run may replace does not count against itself.
    used.delete(path);
    const keep = status === "overwrite" ? existingPort(path) : undefined;
    const taken = new Set(used.values());
    const free = (p: number) => p >= RANGE.min && p <= RANGE.max && !taken.has(p);
    let port: number | undefined;
    if (status === "exists") {
      // Never written, so no port is needed; keep the one on disk for the plan.
      port = existingPort(path) ?? RANGE.base;
    } else if (keep !== undefined && free(keep)) {
      port = keep;
    } else if (service.port !== undefined && free(service.port)) {
      port = service.port;
    } else {
      for (let p = RANGE.base; p <= RANGE.max; p++) {
        if (free(p)) {
          port = p;
          break;
        }
      }
      if (port !== undefined && service.port !== undefined) {
        notes.push(
          `container port ${service.port} is outside TDK's ${RANGE.range} range; TDK assigned ${port}, so the app must read PORT`,
        );
      }
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
    let dockerfile = "./Dockerfile";
    if (!service.image && !service.dockerfile) {
      notes.push("no image or Dockerfile found; add one before `tdk up`");
    } else if (!service.image && service.dockerfile) {
      const found = resolve(plan.root, service.dir, service.dockerfile);
      const rel = relative(dirname(path), found).split("\\").join("/");
      dockerfile = rel.startsWith(".") ? rel : `./${rel}`;
      notes.push(
        "Dockerfile stays in the source tree; TDK builds bring-your-own with the manifest directory as context, so COPY paths may need adjusting",
      );
    }
    if (service.command)
      notes.push("command is kept as dev.command; bring-your-own does not run it");
    if (service.envKeys.length)
      notes.push("environment values are not written; put them in the project .env");

    const manifest: Record<string, unknown> = {
      $schema: SERVICE_MANIFEST_SCHEMA_URL,
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      appName: service.name,
      appType: "bring-your-own",
      stack,
      port,
      healthCheckPath: "/health",
      ...(service.image ? { image: service.image } : { dockerfile }),
      ...(service.kind === "job" ? { restart: "no", exposeViaProxy: false } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(service.command ? { dev: { command: service.command } } : {}),
    };
    items.push({ service, path, manifest, status, notes });
  }
  return { stack, items, rejected };
}

export function applyWrites(writes: WritePlan): WriteItem[] {
  const written: WriteItem[] = [];
  for (const item of writes.items) {
    if (item.status === "exists") continue;
    mkdirSync(dirname(item.path), { recursive: true });
    writeFileSync(item.path, `${JSON.stringify(item.manifest, null, 2)}\n`);
    written.push(item);
  }
  return written;
}

export function manifestRelPath(plan: ImportPlan, item: WriteItem): string {
  return relative(plan.root, item.path).split("\\").join("/");
}
