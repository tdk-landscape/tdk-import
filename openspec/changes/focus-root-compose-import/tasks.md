## 1. Narrow the pipeline

- [x] 1.1 Read only root `docker-compose.yml`; remove the tree walk, `--only`, and the other detector registrations.
- [x] 1.2 Rewrite README and `docs/import.md` for the narrow scope.

## 2. Carry more of Compose

- [x] 2.1 Carry stack, `depends_on`, `build.context`/`dockerfile`, image, HTTP health path, and proxy visibility; never env values.
- [x] 2.2 Write non-HTTP database and broker services as private workers.
- [x] 2.3 Keep a valid Compose port; note when it is outside TDK's usual range.
- [x] 2.4 Write a minimal `.tdk/project.json` when absent; never overwrite one.

## 3. Proof

- [x] 3.1 Unit and e2e tests for the root-only read, workers, port retention, and project config.
- [x] 3.2 Dry-run and generated manifests reviewed against `transmute-app/transmute`.
- [ ] 3.3 `tdk up` reaches service startup and a health URL answers (blocked on the core bootstrap Tiltfile fix).
- [ ] 3.4 Two successful runs on public repos, then mark the PR ready.
