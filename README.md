# tdk-import

Scan a repo and import the services it describes into [TDK](https://github.com/tdk-landscape/tdk-cli-core) as bring-your-own `service.json` files. Part of tdk-landscape/tdk-cli-core#511; the Procfile detector is tdk-landscape/tdk-cli-core#520.

```bash
npx tdk-import . --dry-run     # plan only
npx tdk-import . --yes         # write services/<stack>/<name>/service.json
```

It reads `Procfile`, `docker-compose*.yml`, `Dockerfile` and `package.json`, merges what several files say about one service, lists conflicts instead of guessing, and never overwrites a `service.json` without `--force`. See [docs/import.md](docs/import.md) for what maps, what is skipped, and how to add a detector, and `openspec/changes/import-repo/` for the spec.

Status: not yet published to npm, and imported services have not been run through `tdk up`.

```bash
bun install && bun run build && bun run test
```
