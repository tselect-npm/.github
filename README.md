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
| [`self-check.yml`](.github/workflows/self-check.yml) | Typechecks the CI scripts and lints the workflows in this repository |

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
| `cache` | `pnpm` | Package manager store `actions/setup-node` caches. Set to `''` for a repo with no `pnpm-lock.yaml`, where `cache: pnpm` fails outright |

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

`es-check-version` (`9.6.4`), `attw-version` (`0.18.5`) and `tsx-version`
(`4.23.12`) are fetched with `pnpm dlx`, so they are pinned here rather than
added as a devDependency to seven repos. `tsx` is the one that runs the job
scripts themselves; pinning it means a job cannot change behaviour without a
commit in this repository.

---

## How it is put together

Each job's logic is a TypeScript file. `ci.yml` holds the wiring — the matrix,
the inputs, and the marketplace actions that have to be steps — and nothing else.

```
.github/workflows/ci.yml           the reusable workflow: matrix, inputs, wiring
actions/run-ci-script/action.yml   provisions Node + pnpm, runs a script with tsx
scripts/ci/
  test.ts        static.ts        build.ts        audit.ts        aggregate.ts
  lib/
    core.ts      the slice of @actions/core these scripts use (annotations,
                 groups, job summary, step outputs)
    exec.ts      child processes, with the command echoed
    files.ts     walking the build output
    inputs.ts    the workflow's inputs, typed
    steps.ts     run every step, report every failure
```

A job now reads as "check out, run this script":

```yaml
static:
  steps:
    - uses: actions/checkout@<sha>
    - uses: tselect-npm/.github/actions/run-ci-script@v1
      with:
        script: static.ts
        node-version: ${{ inputs.primary-node-version }}
        install: ${{ inputs.install-command }}
        inputs: ${{ toJSON(inputs) }}
```

### Why not keep it in `run:` blocks

The build job was 80 lines of bash embedded in YAML: quoting rules from two
languages at once, `set -euo pipefail` repeated per step, control flow spread
across `if:` expressions, and no way to check any of it short of pushing a
commit and watching a runner. The same logic in TypeScript is typechecked by
`tsc --noEmit` in [`self-check.yml`](.github/workflows/self-check.yml), reads
top to bottom, and can be run locally against a real package before it ever
reaches a runner.

Two behaviours got *better* rather than merely relocated:

- **Failure collection.** The `if: ${{ !cancelled() && … }}` chain that made
  later gates run after an earlier failure is now [`steps.ts`](scripts/ci/lib/steps.ts).
  Same behaviour — one push surfaces every problem — but the intent is a method
  name instead of an expression to re-derive on every step.
- **The aggregate job** parses `toJSON(needs)` instead of grepping it for
  `"result": "failure"`, so a match can no longer come from somewhere other than
  the field being tested.

### How the scripts reach the runner

`actions/run-ci-script` is a composite action in *this* repository. When a job
references it, the runner clones this repository into its `_actions` directory,
so `scripts/ci/` is reachable through `github.action_path` — the calling
workflow never checks this repository out. tsx is fetched with `pnpm dlx` at a
pinned version, so no package repository carries it as a dependency.

Everything the scripts need arrives as one `${{ toJSON(inputs) }}` blob, read
back through [`inputs.ts`](scripts/ci/lib/inputs.ts). Adding an input to `ci.yml`
and a field to that interface is the whole wiring — there is no per-input `env:`
to thread through a step.

Anything a script needs to hand *back* goes through `core.setResult()`, which a
composite action can only expose as a statically declared output. There is one,
called `result`, carrying JSON; the build job uses it to tell the workflow
whether a tarball exists to upload.

### The wrapper is referenced at `@v1` too

`ci.yml` references the action as `tselect-npm/.github/actions/run-ci-script@v1`
— a full `owner/repo/path@ref`, because inside a reusable workflow `./actions/…`
would resolve against the *caller's* checkout, not this repository.

Both live here, so a caller on `v1` gets the workflow and the action from one
commit, and moving `v1` moves both together. The corollary is a bootstrapping
wrinkle worth knowing before you edit the action: **a pull request against this
repository cannot exercise its own changes to the wrapper**, because the workflow
under review still resolves the action at whatever `v1` currently points to. To
test a change, push a scratch tag and point a caller at it:

```bash
git tag -f v1-test && git push -f origin v1-test
# then, in a package repo, temporarily: uses: tselect-npm/.github/.github/workflows/ci.yml@v1-test
```

---

## What the jobs do, and why

### `test (node NN)` — the matrix

Runs `pnpm cov` on every supported Node line. Coverage runs on all of them rather
than just one because the thresholds (a 95% floor shared across the seven
packages; `url` sits at 100) are part of the gate, and because a runtime-specific
failure should surface as a test failure on that runtime.

This matrix is the point of the whole exercise: the support ceiling used to be
asserted from one local Node and reasoned about. Now it is executed.

### `typecheck + lint` — one job, both results

These packages are tiny (`url` is 163 LOC), so a second runner costs more in
setup than it saves in wall-clock. They share a job, and
[`static.ts`](scripts/ci/static.ts) runs both regardless of the first one's
result — a typecheck failure still reports the lint result, so one push surfaces
every problem instead of one per round-trip.

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
skipped dependency counts as satisfied, so
[`aggregate.ts`](scripts/ci/aggregate.ts) inspects `needs` explicitly and treats
`skipped` as allowed (the caller turned that job off) but `failure` and
`cancelled` as fatal. Anything that is neither an explicit pass nor an explicit
skip is a failure, so a result GitHub adds later cannot quietly go green.

It also writes the per-job table to the run's summary, which is the fastest way
to see *which* job failed without opening the matrix.

This is the one job whose setup costs more than its work: it only reads an
expression context, but it still checks out and provisions pnpm so it goes
through the same wrapper as everything else. Roughly 20 seconds, spent to avoid
having one job that is different for no reason a reader can see.

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

### `engines.node` is the bottom of this matrix

**Every `@tselect` package declares `"engines": { "node": ">=22" }`** — the same
number as the lowest line above, deliberately. `engines` is enforced (pnpm hard-
fails an install below the floor), so it is a promise, and a promise nobody runs
is a comment. Making the floor *equal* the bottom of the matrix means it is
proven by construction, with no extra job and nothing to keep in sync.

`>=20` was the first choice and is not viable. It cannot be tested even if you
add 20 to the matrix: **pnpm 11 declares `node >=22.13` and crashes outright on
Node 20** with `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`
— the install step dies before a single test runs. `tsdown` wants
`^22.18.0 || >=24.11.0` for the same reason. Testing it would mean an npm
fallback on that one matrix row, which is precisely the per-repo special-casing
this repository exists to avoid.

Since `>=20` and `>=22` both break someone and both cost a major version, the tie
goes to the one that can be proven. Node 20 reached EOL on 2026-04-30, so nothing
still receiving security support is dropped.

> This supersedes the original *additive support policy* ("never raise the
> runtime floor, only extend the ceiling"). That policy assumed a wide floor was
> free; it is not, because an undeclared floor is not a wider promise — only an
> untested one. The ceiling half still stands, and `es-check-target` still keeps
> the **emitted syntax** at ES2015 regardless, so the shipped code is not what
> forces the floor. The toolchain is.

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

Every third-party `uses:` is pinned to a full commit SHA with the tag in a
trailing comment — in `ci.yml`, in `self-check.yml`, and in the wrapper action.
Seven repos delegate their CI here; a moved tag upstream should not be able to
change what runs in all of them. [Dependabot](.github/dependabot.yml) keeps the
pins current — a pin nobody updates is just an old version.

Dependabot needs an entry per directory containing a manifest, so
`actions/run-ci-script` is listed separately. Without it the pins inside the
wrapper would be the ones nobody ever updates.

The exception is `run-ci-script@v1` itself, which is pinned to a tag rather than
a SHA. It is not third-party — it is this repository, resolved from the same tag
the caller already chose. See
[The wrapper is referenced at `@v1` too](#the-wrapper-is-referenced-at-v1-too).

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
      cache: ''                   # `cache: pnpm` errors with no pnpm-lock.yaml
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

**The repo must declare `packageManager` in its `package.json`, even on npm.**
`pnpm/action-setup` runs in every job and takes no `version` input here — it
reads that field, and has nothing to fall back on if it is absent. This was
already true before the jobs moved to TypeScript, but it matters more now:
`pnpm dlx tsx` is what runs them, so pnpm is no longer merely on `PATH` and
unused. A single `"packageManager": "pnpm@11.21.0"` line is enough — it does not
commit the repo to installing with pnpm, and `install-command: npm ci` keeps
working alongside it.

`cache: ''` is the one line that is not optional in that shape.
`actions/setup-node` with `cache: pnpm` **fails the job** when there is no
`pnpm-lock.yaml`, rather than skipping the cache, so a repo still installing with
`npm ci` has to turn it off explicitly.

---

## Verification

### The original workflow

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

### The TypeScript scripts

Every script was run locally against the real `tselect-npm/url` working tree —
which is the point of the refactor, and was not possible when the same logic
lived in `run:` blocks. Both the passing and the failing branch of each gate:

| Script | Exercised |
| --- | --- |
| `test.ts` | `cov` (23 tests, 100%); fallback to `test` with `coverage-script: ''`; both empty → exit 1 |
| `static.ts` | typecheck + lint green; `lint-script: ''` reported as skipped |
| `build.ts` | full green path — build, 2 JS + 2 declarations asserted, `es-check es2015` on `.cjs` and `.mjs`, pack, tarball listing to the summary, `attw` *No problems found*, `result` written to `GITHUB_OUTPUT` |
| `build.ts` | `es-check-target: es5` → that gate fails, **pack and attw still run**, exit 1 |
| `build.ts` | missing build script → remaining gates correctly abort, exit 1 |
| `audit.ts` | clean pass; non-zero audit with `audit-blocking: true` → `::error::` + exit 1, and with `false` → `::warning::` + exit 0 |
| `aggregate.ts` | all-success-and-skipped → exit 0; `failure` + `cancelled` → exit 1 naming both |

Plus `tsc --noEmit` over `scripts/`, `actionlint` 1.7.12 clean over both
workflows, and `action.yml` parsed.

> **Not yet exercised on a runner.** The wrapper action's own wiring —
> `github.action_path` resolution, the composite `outputs.result` plumbing,
> `cache: ''` — cannot run until a tag points at a commit containing it, for the
> reason in [The wrapper is referenced at `@v1` too](#the-wrapper-is-referenced-at-v1-too).
> Push a scratch tag and run one package repo against it before moving `v1`.
