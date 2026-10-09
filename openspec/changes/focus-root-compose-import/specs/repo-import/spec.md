## MODIFIED Requirements

### Requirement: Import scans a tree and only runs registered detectors

`tdk-import [dir]` SHALL read exactly `<dir>/docker-compose.yml` (default `dir` is `.`). It SHALL NOT walk subdirectories, read other Compose filenames, or read Dockerfile, `package.json`, or Procfile. The `compose` detector SHALL be the only registered detector, and there SHALL be no `--only` option. The command MUST NOT shell out to Helm, kustomize, or Docker Compose.

#### Scenario: Missing root Compose file fails closed

- **WHEN** a user runs `tdk-import .` in a directory with no `docker-compose.yml`
- **THEN** the command exits non-zero
- **AND** the error says that only the root `docker-compose.yml` is read
- **AND** no file is written

#### Scenario: Nested Compose files are not read

- **WHEN** the tree has a root `docker-compose.yml` and `api/docker-compose.yml`
- **THEN** the plan contains only services from the root file

### Requirement: Merge records conflicts instead of guessing

Candidates for the same directory and name SHALL merge. Two different values for the same field SHALL be a conflict: the plan lists both sources and the written manifest omits that field. Conflicts SHALL cover `image`, `dockerfile`, `command`, `port`, `language`, and `healthCheckPath`.

#### Scenario: Two Compose entries disagree on a health path

- **WHEN** two candidates for service `api` carry different `healthCheckPath` values
- **THEN** the plan reports a `healthCheckPath` conflict
- **AND** the written manifest omits the field

### Requirement: Write is explicit and does not overwrite

The default SHALL print the plan and ask before writing. `--dry-run` SHALL write nothing. `--yes` SHALL write without prompting. An existing `service.json` MUST be left unchanged unless `--force`. When `<root>/.tdk/project.json` does not exist, the write SHALL also create a minimal one enabling the proxy and the imported stack, and MUST NOT overwrite an existing one, with or without `--force`. A Compose container port from 1024 to 65535 SHALL be kept; a port outside TDK's usual range SHALL be noted in the plan. A service with no Compose port SHALL be assigned a free port by TDK.

#### Scenario: Project config is created once

- **WHEN** a user runs `tdk-import . --yes` in a repo with no `.tdk/project.json`
- **THEN** `.tdk/project.json` is created with the imported stack enabled
- **AND** a second run with `--force` leaves it unchanged

#### Scenario: Compose port outside TDK's range is kept

- **WHEN** a Compose service listens on container port 8080
- **THEN** the written `service.json` has port 8080
- **AND** the plan notes the port is outside TDK's usual range

#### Scenario: Database service is a private worker

- **WHEN** a Compose service exposes only port 5432
- **THEN** the manifest sets `appType` to `worker` and `exposeViaProxy` to `false`
- **AND** it has no `healthCheckPath`

### Requirement: The report lists what was not translated

The plan SHALL list Compose constructs that affect service interpretation and were not translated. A skipped Compose feature (`extends`, `profiles`) SHALL name the file and the service. The report MUST NOT be written into `service.json`.

#### Scenario: Unsupported Compose construct is named

- **WHEN** a Compose file uses `extends` on service `api`
- **THEN** the plan names `docker-compose.yml` and `api`
- **AND** other services are still listed
- **AND** the command exits zero if the rest of the plan is valid

### Requirement: First detectors cover the merge shapes

This change SHALL register only `compose`. Compose SHALL read services, `build.context`, `build.dockerfile` (default `Dockerfile`), `image`, command, ports, environment variable names, `depends_on` (restricted to imported service names), and an HTTP URL in `healthcheck.test` as the health path. Environment values MUST NOT be written to `service.json`.

#### Scenario: Build context and dependencies are carried

- **WHEN** Compose service `api` has `build: ./api` and `depends_on: [db]`
- **THEN** the manifest keeps `./api` as the build context
- **AND** sets `dependsOn` to `["db"]`

## REMOVED Requirements

### Requirement: A detector emits candidates, not manifests

**Reason**: The Procfile scenarios no longer apply because the Procfile detector is not registered. The detector-emits-candidates design remains in `design.md`.
**Migration**: None for users; re-adding a detector is a later change.
