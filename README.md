# tdk import

Import the services in a repo's root `docker-compose.yml` into [TDK](https://github.com/tdk-landscape/tdk-cli-core) as `service.json` files. This is the Compose first tier of tdk-landscape/tdk-cli-core#511.

```bash
tdk import . --dry-run     # plan only
tdk import .               # plan, then ask before writing
tdk import . --yes         # write service.json files and project setup
```

It reads one root `docker-compose.yml`, preserves the service build context, image, supported container port, health path, and `depends_on`, and never overwrites `service.json` without `--force`. See [docs/import.md](docs/import.md) for the supported mapping and limits.

## Core version requirement

Use TDK CLI core **1.3.104 or later** to start imported services. Version 1.3.104 is the first release with `buildContext` ([tdk-cli-core#525](https://github.com/tdk-landscape/tdk-cli-core/pull/525), [release 1.3.104](https://github.com/tdk-landscape/tdk-cli-releases/releases/tag/v1.3.104)). Upgrade TDK before running `tdk up` on imported services. If core 1.3.104 is not available in your environment, import cannot be started yet; do not run `tdk up` against an older core. The importer does not check the installed TDK version.

`tdk import` is the existing CLI command backed by this package. The importer does not scaffold app code or edit the original Compose file.

```bash
bun install && bun run build && bun run test
```
