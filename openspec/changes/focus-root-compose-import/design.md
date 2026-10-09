## Context

`import-repo` needed a merge because three files can describe one service. With one input file there is nothing to merge across detectors, so the framework's cost buys nothing yet. The registry and candidate model stay, because the next detector should still be a registry entry, but only `compose` is registered.

## Goals / Non-Goals

**Goals**

- One root Compose file in, a plan out, then an idempotent write that yields a project `tdk up` can load.
- Keep what Compose states (build context, image, port, `depends_on`, health path) instead of replacing it with TDK defaults.
- Never write environment values.

**Non-Goals**

- Walking subdirectories, other Compose filenames, `docker-compose.override.yml`, or `docker compose config`.
- Profiles, `extends`, Helm, Kustomize, CI, or language manifests.
- Rewriting the source repo.

## Decisions

### One fixed input path

`buildPlan` resolves `<dir>/docker-compose.yml` and fails if it is absent. There is no scan, so there is no depth cap, ignore handling, or symlink policy to maintain. This removes the unsupported-infrastructure refusal (Helm, Kustomize) because nothing looks for those files.

### Registry kept, one entry

`selectDetectors(["compose"])` is hard-wired in `plan.ts`. `--only` is removed rather than left accepting a single value, so the CLI does not advertise a choice that does not exist.

### Keep the Compose port

Previously the writer reassigned any port outside TDK's bring-your-own range and told the user the app must read `PORT`. That breaks images that bind a fixed port. The writer now keeps a Compose port when it is 1024 to 65535 and notes when it is outside TDK's usual range. Different containers can share a port, so it is not checked against other services. When Compose gives no port, the writer allocates one from the HTTP range (or 6000-6999 for workers).

### Workers

A service whose only port is a known non-HTTP port is `appType: worker`, `exposeViaProxy: false`, and has no `healthCheckPath`. Everything else gets `healthCheckPath` from an explicit URL in `healthcheck.test`, else `/`.

### Project config

If `<root>/.tdk/project.json` is absent, the writer includes one with the proxy and the imported stack enabled and `discovery.paths: ["services/*/*"]`. It is created with `flag: "wx"`, so an existing file is never overwritten, including by `--force`.

## Risks / Trade-offs

- Dropping the walk makes monorepos with per-service Compose files unsupported. The error names the missing file so this is not silent.
- Keeping the Compose port can collide with a host port TDK assigns elsewhere. Verification against two public repos is still pending and gates leaving draft.
- The `.tdk/project.json` template is a copy of the minimum TDK accepts today and can drift from tdk-cli-core.
- `tdk up` on the sample import (`transmute-app/transmute`) did not reach service startup because the core bootstrap produced no Tiltfile. No health URL has been verified end to end.
