## 1. Registry and types

- [x] 1.1 Add `src/` with candidate types, a detector interface, and a registry. No detector writes files.
- [x] 1.2 Add the scanner: gitignore, hard skips, depth and file caps, no symlinks. Unit test the skips.

## 2. Pipeline

- [x] 2.1 Merge by directory and name with the precedence in the spec. Conflicts omit the field and show both sources.
- [x] 2.2 Plan printer and write step. `--dry-run`, `--yes`, `--only`, `--force`. Existing `service.json` is not overwritten without `--force`.

## 3. Detectors

- [x] 3.1 Procfile detector (#520) and a fixture. This is the smallest end-to-end path.
- [x] 3.2 Dockerfile detector: EXPOSE and CMD to a bring-your-own candidate.
- [x] 3.3 package.json scripts detector. Language set only for an obvious Bun or Node script.
- [x] 3.4 Compose detector for the supported subset. Anchors, `extends`, and profiles go to the skip list.

## 4. Proof

- [x] 4.1 Fixture where Compose, Dockerfile, and package.json describe one service and merge to one manifest.
- [x] 4.2 Fixture with a port conflict. Assert the field is omitted and both sources are in the plan.
- [x] 4.3 Docs page: what maps, what is skipped, and that a new detector is a registry entry.
