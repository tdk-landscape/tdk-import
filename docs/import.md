# Import a Compose project

`tdk import [dir]` reads exactly one file: `<dir>/docker-compose.yml`. It prints the services it can map, their stack, build or image source, container port, health path, and `depends_on` wiring. It asks before writing. `--dry-run` never writes; `--yes` writes the plan without prompting.

```bash
tdk import . --dry-run
tdk import .
tdk import . --yes
```

Each Compose service becomes `services/<stack>/<service>/service.json`. When the repo is not already a TDK project, `--yes` also creates `.tdk/project.json` with the imported stack and Traefik proxy enabled. Existing `service.json` files are kept unless `--force` is passed. Source Compose files are not changed.

## Mapped fields

- `image` is copied as the BYO image.
- `build.context` stays pointed at the original source directory; `build.dockerfile` is retained, defaulting to `Dockerfile`.
- A single Compose port target is retained when it is in TDK's supported service port range. The same service port can be used by separate containers.
- `depends_on` becomes `dependsOn` and only references imported service names.
- An HTTP URL in `healthcheck.test` supplies `healthCheckPath`; otherwise routable services use `/`.
- Environment variable names may appear in the plan, but values are never written.
- Services on common non-HTTP ports (Postgres, MySQL, Redis, Mongo, RabbitMQ, Kafka, Elasticsearch, and Memcached) are imported as private workers.

This importer does not walk subdirectories, read other Compose filenames, merge Dockerfile or language detectors, run `docker compose config`, translate profiles or `extends`, or rewrite the source repo. The report names unsupported Compose fields that affect service interpretation.
