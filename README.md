# `tselect-npm/.github`

Shared GitHub Actions workflows for the seven `@tselect` packages, plus the
[organization profile README](profile/README.md).

The `@tselect` packages are a **polyrepo** — `access-control`, `countries`,
`http-method`, `schema`, `status-code`, `thrown` and `url` are independent
repositories with their own release cycles. This repository is the one place
their CI logic is allowed to be shared.

| Workflow | Purpose |
| --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | Typecheck · lint · test + coverage · build · audit, across the supported Node matrix |

---

## Using it

Add this to a package repo as `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# Cancellation belongs to the caller — see "Concurrency" below.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  ci:
    uses: tselect-npm/.github/.github/workflows/ci.yml@v1
```

That is the whole caller for a repo on the current toolchain — every input has a
default suited to it.

### Pin a tag, never `@main`

Central logic is leverage in both directions. An edit to `main` here would change
all seven repos' CI on their next run, with no review in any of them. Callers
**must** reference a tag:

```yaml
uses: tselect-npm/.github/.github/workflows/ci.yml@v1   # ✅
uses: tselect-npm/.github/.github/workflows/ci.yml@main # ❌
```

`v1` is a moving major tag: fixes and backwards-compatible additions move it, so
repos pick them up without edits. Anything that could turn a passing build red —
a new blocking gate, a removed input, a changed default — gets `v2`, and repos
migrate one at a time. Immutable `v1.x.y` tags are pushed alongside it for a repo
that wants to pin harder.

### Concurrency

The reusable workflow deliberately sets no `concurrency` block. Inside a reusable
workflow `github.workflow` and `github.ref` resolve to the *caller's*, so two
caller jobs pointing at this file land in the same group and cancel each other —
which is exactly what happened the first time this was tested. Set it in the
caller, as the template above does.

### Branch protection

Require the check named **`ci`**. It is an aggregate job that depends on all the
others, so it stays stable while matrix job names (`test (node 26)`, …) change
with `node-versions`. Requiring the matrix names directly would mean editing
seven repos' settings every time the Node schedule moves.

---

## Inputs

Everything is optional. Scripts are named as **`package.json` script names**, not
commands, and setting one to `''` skips that step — so a repo part-way through
its migration can adopt the workflow before it has every script.

### Matrix

| Input | Default | Notes |
| --- | --- | --- |
| `node-versions` | `'["22", "24", "26"]'` | JSON array. See [Node matrix](#node-matrix) |
| `primary-node-version` | `'24'` | Runs the static checks and the build, and uploads coverage. Must be one of `node-versions` |
| `runs-on` | `ubuntu-latest` | |

### Scripts

| Input | Default | Notes |
| --- | --- | --- |
| `typecheck-script` | `typecheck` | `tsc --noEmit` |
| `lint-script` | `lint` | `biome check .` — Biome checks formatting too, so there is no separate format job |
| `coverage-script` | `cov` | Runs on **every** matrix entry |
| `test-script` | `test` | Only used when `coverage-script` is `''` |
| `build-script` | `build` | `''` skips the whole build job |
| `install-command` | `pnpm install --frozen-lockfile` | |

### Coverage

| Input | Default | Notes |
| --- | --- | --- |
| `coverage-lcov` | `coverage/lcov.info` | |
| `upload-coverage` | `true` | Coveralls |

### Publishable artifact

| Input | Default | Notes |
| --- | --- | --- |
| `dist-dir` | `dist` | |
| `es-check-target` | `es2015` | `thrown` sets `es2016` |
| `check-types-resolution` | `true` | `@arethetypeswrong/cli` |
| `attw-profile` | `node16` | `strict` ignores nothing, including node10 resolution |
| `upload-package` | `true` | Keeps the packed tarball as an artifact for 7 days |

### Audit

| Input | Default | Notes |
| --- | --- | --- |
| `audit` | `true` | |
| `audit-level` | `low` | |
| `audit-blocking` | `true` | Set `false` while a repo is still on the old toolchain |

### Pinned tool versions

`es-check-version` (`9.6.4`) and `attw-version` (`0.18.5`) are fetched with
`pnpm dlx`, so they are pinned here rather than added as a devDependency to seven
repos.

---

## What the jobs do, and why

### `test (node NN)` — the matrix

Runs `pnpm cov` on every supported Node line. Coverage runs on all of them rather
than just one because the thresholds (100% for `url`) are part of the gate, and
because a runtime-specific failure should surface as a test failure on that
runtime.

This matrix is the point of the whole exercise: the support ceiling used to be
asserted from one local Node and reasoned about. Now it is executed.

### `typecheck + lint` — one job, both results

These packages are tiny (`url` is 163 LOC), so a second runner costs more in
setup than it saves in wall-clock. They share a job, but the lint step carries
`if: ${{ !cancelled() }}` — a typecheck failure still reports the lint result, so
one push surfaces every problem instead of one per round-trip.

Biome's `check` covers linting *and* formatting, so a single `pnpm lint` serves
both concerns. `biome ci` was considered — it is the CI-oriented variant, never
writes files, and offers `--reporter=github` for inline PR annotations. It is not
used because this workflow must stay tool-agnostic: six of the seven repos are
still on TSLint, and hardcoding a Biome subcommand would fork the workflow per
repo, which is exactly what it exists to avoid. A repo that wants the annotations
can add `"lint:ci": "biome ci --reporter=github"` and set `lint-script: lint:ci`.

### `build + package` — distrusting the exit code

A build tool can report success and still drop declarations (this is why the
pilot replaced tsup with tsdown), and a packing mistake can ship a tarball with
no JavaScript at all (`@tselect/url@1.0.0` did exactly that, and
`npm pack --dry-run` in a dirty tree hid it). So the build job asserts outcomes
rather than exit codes:

1. **`dist` contains non-empty JavaScript and non-empty declarations.**
2. **Emitted syntax is no newer than `es-check-target`.** The support policy is
   additive — the runtime floor may never rise. `es-check` parses the output with
   acorn at the target version. This replaces grepping for `?.`, `??` and private
   fields, which needs comments stripped first (tsdown emits `//#region` markers)
   and can only find syntax it was told to look for. `.cjs` is checked as script,
   `.mjs` as module, and bare `.js` according to the package's `type` field.
3. **The tarball is packed for real and read back**, and must contain
   JavaScript. Its full file list goes to the job summary. Packing into an empty
   directory rather than parsing `pnpm pack`'s stdout matters, because `prepack`
   writes to stdout too.
4. **`@arethetypeswrong/cli` runs against that tarball**, validating the
   `exports` map and dual-package type resolution. This is the check that would
   have caught the pilot's headline bug before consumers did.
5. The tarball is kept as an artifact. Publishing is still manual, so having the
   exact reviewed artifact to hand is worth the 7 days of retention.

### `audit` — the zero-vulnerabilities gate

`pnpm audit --audit-level low`, with no install (pnpm audits the lockfile). Zero
vulnerabilities is a standing requirement that was previously verified by
remembering to run it. Now nothing merges past a new advisory.

The six repos still carrying the old mocha/nyc/TSLint tree have live advisories
today, so they adopt the workflow with `audit-blocking: false` — the findings are
reported as warnings and the rest of CI still gates. They flip it to `true` as
part of their test-migration PR, the same PR that removes the advisories.
Advisory mode is a step-level branch rather than job-level `continue-on-error`,
so `needs.audit.result` stays unambiguous for the aggregate job.

This covers pushes and pull requests only. A scheduled run that catches
advisories published against unchanged code would be a separate workflow; it is
not here yet.

### `ci` — the aggregate

One stable check name for branch protection. `needs` alone is not sufficient: a
skipped dependency counts as satisfied, so the job inspects `needs` explicitly
and treats `skipped` as allowed (the caller turned that job off) but `failure`
and `cancelled` as fatal.

---

## Node matrix

Defaults to **22 · 24 · 26**, re-resolved against the live schedule on
2026-08-09:

| Line | Status | EOL |
| --- | --- | --- |
| ≤ 20 | **EOL** — 20 went EOL 2026-04-30 | — |
| 22 | Maintenance LTS | 2027-04-30 |
| 24 | Active LTS | 2028-04-30 |
| 26 | Current; LTS from 2026-10-28 | 2029-04-30 |

So the default is *every Node line still receiving security support, and nothing
else*. `primary-node-version` is 24, the active LTS.

When 22 goes EOL, editing this file's default and moving the `v1` tag updates all
seven repos at once. That is the leverage the tag pin protects.

> **`engines.node` is still undeclared.** It was deferred to this CI work so the
> declared floor would ship with the matrix that proves it, and it has been
> deferred again: the matrix now exists, but no package declares a contract. The
> options remain `">=22"` (matches the matrix exactly; a major for all seven),
> `">=6"` (what the ES2015 zero-dependency output genuinely runs on;
> non-breaking, but claims lines nothing tests) and `">=20"` (still a floor raise,
> still a major). See `URL-PILOT.md` §3.

---

## Toolchain assumptions

The defaults target the shape the `url` pilot settled on:

| Concern | Tool |
| --- | --- |
| Package manager | pnpm 11.21.0, pinned via `packageManager`; settings in `pnpm-workspace.yaml` |
| Build | tsdown |
| Tests + coverage | Vitest 4 + `@vitest/coverage-v8` |
| Lint **and format** | Biome 2.5.7 |
| Typecheck | TypeScript 7.0.2 (`tsc --noEmit`) |

### pnpm, not Corepack

pnpm comes from `pnpm/action-setup`, which reads the version from the
`packageManager` field. Corepack is deliberately unused, and this was measured
rather than assumed:

- **Node stopped shipping Corepack at v25.** On a Node 26 runner there is no
  `corepack` beside the `node` binary.
- `corepack --version` nevertheless answers `0.34.6` on `ubuntu-24.04`, because
  the runner image carries a globally installed copy. That is an image detail,
  not a contract — it can disappear in any image refresh, and it would take all
  seven repos with it.

`pnpm/action-setup` is used over its newer successor `pnpm/setup@v2`. Both were
tested against `url` on 22/24/26 and both work. `pnpm/setup` is the more elegant
option — one step for pnpm *and* the runtime — but it provisions Node through
pnpm's own runtime downloader instead of the Actions toolcache, its v2 line is
days old, and in the probe its store cache key did not vary with the Node
version, so matrix jobs collided on the cache. `pnpm/action-setup` +
`actions/setup-node` is the boring option, and CI's job is to be boring. Worth
revisiting once `pnpm/setup` has some mileage.

Step order matters: pnpm is installed *before* `actions/setup-node`, because
`cache: pnpm` needs pnpm on `PATH` to locate the store.

### Actions are pinned to commit SHAs

Every `uses:` in `ci.yml` is pinned to a full commit SHA with the tag in a
trailing comment. Seven repos delegate their CI here; a moved tag upstream should
not be able to change what runs in all of them.

### Coverage goes to Coveralls

`coverallsapp/github-action` authenticates with the built-in `GITHUB_TOKEN`, so
**no secret has to be provisioned in any of the seven repos** and the Coveralls
project is created on first upload. Codecov was the alternative and has the
better UI, but since v4 it needs a `CODECOV_TOKEN` even for public repos, which
would mean either seven secrets or an org secret plus `secrets:` plumbing through
every caller — a lot of moving parts for a badge.

Uploads are skipped for pull requests from forks (read-only token) and use
`fail-on-error: false`, so a Coveralls outage cannot redden a build. The coverage
*thresholds* are enforced by Vitest inside the test job, which is the real gate;
Coveralls only reports.

Badge for a package README:

```markdown
[![Coverage](https://coveralls.io/repos/github/tselect-npm/url/badge.svg?branch=main)](https://coveralls.io/github/tselect-npm/url?branch=main)
```

CI badge:

```markdown
[![CI](https://github.com/tselect-npm/url/actions/workflows/ci.yml/badge.svg)](https://github.com/tselect-npm/url/actions/workflows/ci.yml)
```

---

## Adopting it in a repo still on the old toolchain

The six unmigrated repos are on npm + mocha + chai + nyc + TSLint. They can adopt
the workflow before migrating, by turning off what they do not have yet:

```yaml
jobs:
  ci:
    uses: tselect-npm/.github/.github/workflows/ci.yml@v1
    with:
      install-command: npm ci
      typecheck-script: ''        # no typecheck script yet
      coverage-script: ''         # nyc is not wired to lcov
      es-check-target: ''         # single-format tsc output, nothing to assert
      check-types-resolution: false
      audit: false                # no pnpm-lock.yaml yet
```

Each line is removed as the corresponding migration PR lands, which makes the
caller file a visible progress bar for that repo. Once a repo is on pnpm but not
yet off mocha/nyc, re-enable `audit` with `audit-blocking: false` so the
remaining advisories are reported without blocking.

Note that `pnpm/action-setup` still runs even with `install-command: npm ci`;
that is harmless, since it only puts pnpm on `PATH`.

---

## Verification

`ci.yml` was exercised through `workflow_call` against a temporary copy of
`tselect-npm/url` at the tip of its modernization stack (`fb04963`), in both the
default shape and the degraded shape documented above, before this workflow was
opened. Green on all of:

- install from the lockfile, typecheck, lint, coverage — on Node 22, 24 and 26
- build, declaration assertion (2 JS + 2 `.d.*` emitted), `es-check es2015` on
  both `.cjs` and `.mjs`
- pack, tarball JavaScript assertion, `attw` — *No problems found*
- `pnpm audit --audit-level low` — *No known vulnerabilities found*
- `actionlint` over `ci.yml` itself
- the aggregate job, with the degraded caller's skipped jobs correctly treated as
  passing

Corepack's presence was measured per Node version in a separate probe, and both
pnpm setup actions were compared on the same three versions.

The one path not exercised is the Coveralls upload, which was disabled during
testing so it would not create a Coveralls project for this repository. It is
`fail-on-error: false`, so the worst case is a missing report rather than a red
build.
