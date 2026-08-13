# `tselect-npm/.github`

Shared GitHub Actions workflows and repository rulesets for the seven `@tselect`
packages, plus the [organization profile README](profile/README.md).

The `@tselect` packages are a **polyrepo** — `access-control`, `countries`,
`http-method`, `schema`, `status-code`, `thrown` and `url` are independent
repositories with their own release cycles. This repository is the one place
their CI logic is allowed to be shared.

| Workflow | Purpose |
| --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | Typecheck · lint · test + coverage · build · audit, across the supported Node matrix |
| [`publish.yml`](.github/workflows/publish.yml) | Manually triggered release: infer the version from gitmoji, gate on approval, tag, publish to npm |
| [`self-check.yml`](.github/workflows/self-check.yml) | Typechecks the CI scripts, lints the workflows, and parses the rulesets and environments |

Alongside them, [`rulesets/`](rulesets/) holds four importable branch rulesets —
one protection per file, so each can be disabled on its own — and
[`environments/`](environments/) holds the deployment environment that decides who
may approve a release. See [Rulesets](#rulesets) and [Publishing](#publishing).

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

Require the check named **`ci / ci`** — `ci` is the aggregate job, and the
`ci /` prefix is the caller's job id, which is how a reusable workflow's jobs are
reported. The aggregate depends on all the others, so the name stays stable while
matrix job names (`ci / test (node 26)`, …) change with `node-versions`.
Requiring the matrix names directly would mean editing seven repos' settings
every time the Node schedule moves.

The four rulesets in [`rulesets/`](rulesets/) are the ready-made version of this
— see below.

---

## Publishing

[`publish.yml`](.github/workflows/publish.yml) releases a package **from CI and
nowhere else**. Once a package is set up for trusted publishing there is no npm
token in existence for it, so a laptop cannot publish even by accident.

A release is one click in a repo's **Actions → Publish → Run workflow**, and the
run does the rest: read the bump out of the gitmoji since the last release, stop
for an approval from the shortlist, bump `package.json`, commit and tag on the
release branch, publish.

The caller goes in each package repo as `.github/workflows/publish.yml`:

```yaml
name: Publish

on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'Version bump. `auto` reads it from the gitmoji since the last release.'
        type: choice
        options: [auto, patch, minor, major]
        default: auto
      dry-run:
        type: boolean
        default: false
      dist-tag:
        type: string
        default: latest
      since-ref:
        description: 'Count commits from here instead of the tag matching the published version.'
        type: string
        default: ''

concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false     # never cancel a release — see "Ordering" below

jobs:
  publish:
    permissions:
      contents: write   # push the release commit and the tag
      id-token: write   # mint the OIDC token npm exchanges for publish rights
    uses: tselect-npm/.github/.github/workflows/publish.yml@v1
    with:
      bump: ${{ inputs.bump }}
      dry-run: ${{ inputs.dry-run }}
      dist-tag: ${{ inputs.dist-tag }}
      since-ref: ${{ inputs.since-ref }}
```

Every dispatch input is forwarded rather than left to the reusable workflow's
default. An input the caller does not forward cannot be set at all — the run
form is the caller's, so a reusable-workflow input with no caller counterpart is
unreachable in practice.

### Two rules that are not obvious and fail identically

Both produce a `404` from the registry that says nothing about the actual cause,
so they are worth knowing before debugging one.

* **The caller must be named `publish.yml`.** npm's trusted publisher config
  names one workflow file per package, and for a reusable workflow npm validates
  the **caller's** filename, not the reusable one. All seven callers are
  therefore identically named — this is the one file in the organization whose
  name is load-bearing.
* **`id-token: write` is required in the caller too.** A called workflow can only
  narrow the permissions it was given, never widen them, so a caller that leaves
  it out produces a job with no OIDC token at all. That is why the template sets
  permissions explicitly instead of relying on the repository default.

### How the version is decided

The bump comes from the gitmoji in the commit subjects since the last release —
the same bet semantic-release makes on Conventional Commits, with the marker
these histories have actually used since 2016. The table lives in
[`gitmoji.ts`](scripts/ci/lib/gitmoji.ts); its shape is:

| Level | Markers |
| --- | --- |
| `major` | `:boom:`, or a `BREAKING CHANGE:` trailer in the body |
| `minor` | `:sparkles:`, `:tada:` |
| `patch` | `:bug:`, `:lock:`, `:zap:`, `:recycle:`, `:arrow_up:`, `:fire:`, … — anything a consumer can observe |
| *nothing* | `:memo:`, `:white_check_mark:`, `:construction_worker:`, `:wrench:`, `:bookmark:`, … — tooling and docs |

Three deliberate choices in it:

* **Only `:boom:` infers a major.** gitmoji has no other unambiguous breaking
  marker, and guessing one from `:fire:` (remove code) or `:truck:` (rename
  resources) would put a consumer's install on the line. Those two are warned
  about instead.
* **Unrecognized subjects count as a patch**, not as nothing, and are warned
  about by name. Someone has already decided to publish by the time this runs;
  silently discounting a commit is the worse failure.
* **A range of nothing but tooling commits is an error**, not a no-op release. It
  asks for an explicit bump rather than guessing.

**The `bump` override is not an escape hatch — it is a required part of the
design.** The sharpest edge in the table is that `:wrench:` releases nothing,
and the pilot's `:wrench: Declare engines.node >=22` *is* a breaking change under
the support policy. Raising the runtime floor, changing an `exports` map and
dropping an export are all breaking regardless of the emoji in front of them.
**All seven modernization majors therefore ship with `bump: major` chosen
explicitly**, and the plan job prints the inference it overrode.

### The base version is `package.json`, not the newest tag

This is backwards from what a release tool usually assumes, and these
repositories force it. `url`'s tags run to `v3.0.0-beta.2` from its `@bluejay/url`
days, while the registry serves `@tselect/url@1.0.0` and `package.json` says
`1.0.0`. Inferring the base from `git describe` would propose `3.0.0` for a
package whose latest published version is `1.0.0`.

package.json is what was published, so package.json is the base. The **tags** are
only used to bound the commit range, in this order: `since-ref` if given, then a
tag matching the published version (with and without the `v` — `url` has a bare
`1.0.0` next to a `v2.0.1`), then the newest reachable semver tag, then the whole
history. Each fallback warns louder than the last.

> **The pre-`@tselect` tags have to be cleared before a repo's first release**,
> and the fix is the same everywhere. The `@bluejay` era left tags that the
> `@tselect` line is now walking back into: `v2.0.0` — the exact tag a
> modernization major wants — existed in `url`, `access-control`, `countries` and
> `http-method`. The plan job refuses to move a tag, so this is a red plan job
> until it is settled.
>
> **The registry says where the real tag belongs.** npm records the commit each
> version was published from, so this is a lookup rather than a guess:
>
> ```console
> $ npm view @tselect/url@1.0.0 gitHead
> de093bb54ecba3a0c84d31badd26654708631454   # :sparkles: Cleanup and migrate to tselect
> ```
>
> Delete the obsolete tags, then tag *that* commit `v1.0.0`. The published
> version and the tag naming it now agree, which is the assumption the whole
> range resolution rests on — and `since-ref` stops being necessary, because the
> tag matching the published version is found on the first try.
>
> `url` was done this way (2026-08-13): seven `@bluejay` tags removed, `v1.0.0`
> created at `de093bb`. The range went from 24 commits reaching back into a
> foreign lineage to the 9 that are actually the modernization. **`access-control`,
> `countries` and `http-method` still need it**, as part of their step 8.

### Ordering, and what a failure leaves behind

The tag is pushed **before** `pnpm publish`. Neither order is atomic, so the
choice is about which half-done state is recoverable:

| Order | If it fails in between |
| --- | --- |
| Publish, then tag | A version on the registry that no commit is tagged with. npm forbids republishing a version, so the only way out is to bump past it — the version number is burned. |
| **Tag, then publish** | A tag and a `:bookmark:` commit on `main` for a version the registry does not have. **Re-running the workflow fixes it.** |

Re-running is the recovery procedure, and the scripts are built for it: the plan
job notices the manifest version was never published and proposes *that* version
again rather than bumping past it, and every mutation in the publish job is
skipped when it has already happened.

What makes the ordering tolerable is the rehearsal: `pnpm publish --dry-run` runs
`prepublishOnly` — lint, coverage, build — and packs the tarball **before**
anything is pushed. The overwhelmingly likely reasons a publish fails have
already happened by then.

Two more things the publish job does not take on trust:

* **The plan still describes this checkout.** An approval can sit for hours. The
  job re-reads HEAD and fails if the branch moved, so a commit merged during the
  approval window cannot ride out under a version inferred without it.
* **The registry is asked whether the publish landed.** Same rule the build job
  follows: a publish that reports success and did not land is a failure these
  packages have already met.

### Environments — who may release

[`environments/npm-publish.json`](environments/npm-publish.json) is the
environment the publish job runs in, in the shape the REST API takes. As with the
rulesets, nothing consumes it automatically; it is the reviewed source of truth
for a setting that otherwise lives only in seven Settings tabs where nobody can
diff it.

Two of its fields are the whole access-control story:

* `reviewers` — **the shortlist.** Only these people can approve a release.
* `deployment_branch_policy` — the environment, and with it the OIDC token, is
  not handed to a job running from an unprotected branch.

`prevent_self_review: true` means whoever starts a release cannot approve it, so
**the shortlist needs at least two people to be workable.** Drop it to `false` for
a one-maintainer package, knowingly.

> **What this does and does not restrict.** GitHub has no way to limit who may
> *trigger* a `workflow_dispatch` — anyone with write access can start a release.
> What the environment gates is everything that follows: the run stops at the
> plan and goes no further without an approval from the list, and the OIDC token
> npm requires does not exist until then. Approval is the gate, not triggering.
> That is also why the plan job runs *outside* the environment: the version, the
> tag and the commits behind them are on screen before the approval is requested,
> instead of the reviewer signing a blank cheque.

Replace the placeholder id, then apply it per repo — the ids are numeric, not
logins:

```bash
gh api /orgs/tselect-npm/teams/<slug> --jq .id      # or /users/<login>
gh api -X PUT repos/tselect-npm/<repo>/environments/npm-publish \
  --input environments/npm-publish.json
```

### The npm side

Per package, once, at **npmjs.com → the package → Settings → Trusted publisher**:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization | `tselect-npm` |
| Repository | the package's repo |
| Workflow filename | `publish.yml` — the **caller's** name |
| Environment | `npm-publish` |
| Allowed actions | `npm publish` (configs created after 2026-05-20 must pick at least one) |

Then **revoke the classic npm token**, which is the step that makes "CI and
nowhere else" true rather than aspirational.

Trusted publishing cannot create a package's *first* version, so it works here
only because all seven already exist on the registry. It also does not stop an
attacker who lands a commit — a malicious commit would ship with a valid
provenance attestation. The rulesets, the required review and the approval
shortlist are what cover that; provenance covers the build, not the source.

### The release commit needs a ruleset bypass

The publish job pushes a `:bookmark: X.Y.Z` commit straight to the release
branch, which `pr-required` forbids. That is why the GitHub Actions app is listed
as a bypass actor in [`pr-required.json`](rulesets/pr-required.json) — see
[Rulesets](#rulesets) for why that is the only bypass in the four. Two
consequences worth knowing:

* A push authenticated with `GITHUB_TOKEN` does **not** trigger workflows, so the
  release commit will not start a CI run of its own. Nothing loops.
* The bypass is scoped to that app, not to a person, and the only workflow that
  uses it is this one — every other path to `main` is still a pull request.

---

## Rulesets

[`rulesets/`](rulesets/) holds four repository rulesets as importable JSON, one
protection each:

| File | Rule | Effect on the default branch |
| --- | --- | --- |
| [`pr-required.json`](rulesets/pr-required.json) | `pull_request` | No direct pushes; changes land through a squashed PR |
| [`ci-required.json`](rulesets/ci-required.json) | `required_status_checks` | `ci / ci` must pass |
| [`no-force-push.json`](rulesets/no-force-push.json) | `non_fast_forward` | No force-pushes |
| [`no-delete.json`](rulesets/no-delete.json) | `deletion` | The branch cannot be deleted |

All four target `~DEFAULT_BRANCH` only, so feature branches stay free to be
force-pushed, rebased and deleted.

`pr-required` carries three settings beyond "a PR is required", since the
`pull_request` rule is the one place they can live:

* `required_approving_review_count: 0` — one person maintains all seven repos, so
  requiring an approval would mean requiring a bypass. The PR still has to exist,
  which is what makes CI run and the diff readable before it lands.
* `required_review_thread_resolution: true` — a comment thread has to be resolved
  rather than scrolled past. Cheap when the reviewer is you; the point is that
  CodeQL and review comments cannot be merged over silently.
* `allowed_merge_methods: ["squash"]` — `main` gets one commit per PR. Note the
  trade: a branch with a curated gitmoji history collapses into a single commit,
  and the individual messages survive only in the squash body.

### Why four files and not one

One ruleset carrying all four rules is a single switch: needing to force-push
once means turning off the PR requirement and the CI gate at the same time. Split
one-per-file, each protection is disabled and re-enabled on its own, and the
repo's rules list reads as four named lines rather than one opaque entry.

That granularity is the reason **`bypass_actors` carries no human**. A standing
`OrganizationAdmin` bypass would make every rule advisory for the only person who
pushes here, which is the same as not having them. The escape hatch is to set that
one ruleset to **Disabled**, do the thing, and set it back — visible in the
ruleset's history, unlike a silent bypass.

The single exception is the **GitHub Actions app (`15368`) on `pr-required`**,
added so [`publish.yml`](.github/workflows/publish.yml) can push its
`:bookmark: X.Y.Z` release commit to the branch. It is worth being clear about
what it widens: any workflow in the repo with `contents: write` can now push to
the default branch. What keeps that narrow is that a workflow is itself code that
had to land through a pull request, and the only one using it stops for an
approval first. The other three rulesets — including `no-force-push` and
`no-delete` — have no bypass at all, so the release commit can be added but never
rewritten away.

### Importing

Per repo: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, then
pick the file. Repeat for each of the four. The `name` in each file is what the
ruleset is called once imported, and it matches the filename so a ruleset in the
settings UI can be traced back here.

Nothing keeps an imported copy in sync with this repository — an edit here has to
be re-imported (or hand-applied) in each repo. With seven repos and four files
that is 28 imports, which is the cost of these being repository rulesets rather
than one org ruleset. They are repository rulesets on purpose: an org ruleset
cannot be disabled for a single repo, so a repo mid-migration could not opt out
of the CI gate before it has CI.

### Two things to check before importing `ci-required`

* The repo must already have a green `ci / ci` run. A required check that has
  never reported blocks every PR, with nothing to click.
* `integration_id` is `15368` — GitHub Actions. It pins the check to that app, so
  another integration cannot satisfy the requirement by posting a status with the
  same name.

`strict_required_status_checks_policy` is `false`: a PR does not have to be
rebased onto the tip of the default branch before merging. These packages are
small and rarely have two PRs open at once, so the requirement would mostly be a
round-trip. `do_not_enforce_on_create` is `true` so branch creation is not
blocked by a check that has not run yet.

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
.github/workflows/publish.yml      the reusable release: plan, approve, tag, publish
actions/run-ci-script/action.yml   provisions Node + pnpm, runs a script with tsx
scripts/ci/
  test.ts        static.ts        build.ts        audit.ts        aggregate.ts
  publish-plan.ts                  decide the release; change nothing
  publish.ts                       bump, commit, tag, push, publish
  lib/
    core.ts      the slice of @actions/core these scripts use (annotations,
                 groups, job summary, step outputs)
    exec.ts      child processes, with the command echoed
    files.ts     walking the build output
    git.ts       the git the release does, kept mechanical
    gitmoji.ts   the gitmoji → major/minor/patch table
    inputs.ts    each workflow's inputs, typed
    semver.ts    parse and increment a version, without the dependency
    steps.ts     run every step, report every failure
```

The release scripts sit in `scripts/ci/` with the rest rather than in a directory
of their own: the wrapper action resolves scripts relative to that one path, and a
second location would mean a second wrapper input for no gain.

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

### The wrapper is pinned to an immutable version tag

`ci.yml` and `publish.yml` reference the action as
`tselect-npm/.github/actions/run-ci-script@v1.2.0` — a full
`owner/repo/path@ref` at an **immutable** tag, bumped in the same commit that
then receives that tag. Both workflows move together: they ship from one
repository, so a wrapper change is released once and every reference to it goes
to the new version in that same commit.

That looks redundant when the workflow and the action ship from one repository,
and the two more obvious forms were both tried on a real runner first. Both fail:

| Form | What happens |
| --- | --- |
| `…/run-ci-script@v1` | The action ref resolves **independently** of the tag the caller used for the workflow. Loading the workflow from a scratch tag still loads the wrapper from wherever `v1` points — the previous release. `Can't find 'action.yml' … for action 'tselect-npm/.github/actions/run-ci-script@v1'` |
| `./actions/run-ci-script` | A relative ref inside a reusable workflow resolves against the **caller's** workspace, not this repository. `Can't find 'action.yml' … under '/home/runner/work/url/url/actions/run-ci-script'` |

So `@v1` is untestable-before-release and `./` is simply wrong. An immutable
version tag is the only form where tagging a branch makes *both* the workflow and
the wrapper resolve to that branch, which is what lets a change run before it is
released.

The cost is real: **every change to the wrapper needs the version bumped here**,
in the same commit. That is deliberate — it is what keeps the pairing visible in
review instead of implicit in a tag that moves later.

### Releasing a change

`v1` is what callers use, so nothing reaches a package repository until it moves.
That makes the order matter:

```bash
# 1. On the branch, with the workflows' wrapper refs already bumped:
git tag -f v1.2.0 && git push -f origin v1.2.0     # the wrapper now resolves
git tag -f v1-test && git push -f origin v1-test   # the workflow, for the probe

# 2. In one package repo, on a throwaway branch, point the caller at the probe:
#      uses: tselect-npm/.github/.github/workflows/ci.yml@v1-test
#    …open a PR so the workflow actually triggers, and read the run.

# 3. Iterate: amend, force both tags to the new head, push, re-run.

# 4. Merge, then move the tag callers actually use:
git tag -f v1 && git push -f origin v1
git push origin :refs/tags/v1-test                 # tidy up
```

Force-moving `v1.2.0` during step 3 is fine — nothing consumes it until `v1`
moves. Once it does, treat it as immutable.

A package repo's probe branch is disposable and should never be merged; the
caller file on `main` always points at `v1`.

**Probing `publish.yml` needs one change to that recipe.** It is
`workflow_dispatch`, so a pull request does not trigger it — the probe caller has
to be on the *default* branch of the package repo to be dispatchable at all, and
`dry-run: true` is what makes running it safe. A dry run still requires the
environment approval and still performs the full rehearsal (`prepublishOnly` and
the pack), then stops before the commit, the tag, the push and the publish. It is
the only way to exercise the approval path without burning a version.

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

### The wrapper, on a runner

The wrapper's own wiring cannot be exercised by a pull request against this
repository, so it was probed from `tselect-npm/url` against a scratch tag before
`v1` moved. That probe is what established the ref-resolution table above — the
first two attempts failed in 2–4 seconds, both at action resolution rather than
in any job logic.

### The rulesets

All four were imported into `tselect-npm/url` and are active there. Read back
through the API, each one round-trips to what is in this directory:

```console
$ gh api repos/tselect-npm/url/rulesets --jq '.[] | "\(.name)\t\(.enforcement)"'
ci-required     active
no-delete       active
no-force-push   active
pr-required     active
```

One thing that shows up on the way back and not on the way in: GitHub fills in
`dismissal_restriction` and `required_reviewers` on the `pull_request` rule
itself. They are defaults, not something the import dropped or changed — but a
ruleset re-exported from the settings UI will carry them, so a diff against
`pr-required.json` is not evidence of drift.

The one value that cannot be checked by parsing is the required check name.
`ci / ci` and `integration_id: 15368` were read off the live check runs on
`tselect-npm/url`'s `main`, not inferred from `ci.yml`:

```console
$ gh api repos/tselect-npm/url/commits/main/check-runs \
    --jq '.check_runs[] | "\(.name)\tapp=\(.app.id)"'
ci / ci                 app=15368
ci / typecheck + lint   app=15368
ci / test (node 26)     app=15368
…
```

That is also what corrected this README, which said to require `ci`. The `ci /`
prefix is the caller's job id, so a package repo that renames that job in its own
`.github/workflows/ci.yml` changes the check name and has to edit
`ci-required.json` to match. None of the seven do — the template names it `ci`.

### The release workflow

`publish.yml` has not been run on a runner, and the parts that can only be
verified there are called out below. What was verified was verified the way the
CI scripts were — by running them against a real working tree.

`publish-plan.ts` was run against the real `tselect-npm/url` checkout on `main`,
which is what surfaced two findings that are now documented rather than
discovered later:

- With `bump: auto` it inferred `minor` (from two `:sparkles:` commits) and then
  **refused the release** — `v1.1.0 already exists at 75d78bf`. That was the
  `@bluejay`-era tag collision, since fixed for this repo by the retagging
  described above.
- The commit range reached back **24 commits** into the `@bluejay` history,
  because the tag matching the published `1.0.0` was bluejay's `1.0.0`. Also
  fixed by the retagging — the range is now the 9 modernization commits.

Both were found by running the script, not by reading it, which is the argument
for these jobs being TypeScript. Re-run after the retag, with `bump: major` and
no `since-ref`, it resolves cleanly: `Counting commits since v1.0.0, the tag for
the published version` → 9 commits → `@tselect/url: 1.0.0 → 2.0.0`, with the
override reported as `major, chosen explicitly (gitmoji implied minor)` and no
warnings.

The classification was checked against all 24 commits of the wider range —
`:wrench:`, `:bookmark:` and `:construction_worker:` as no-release, `:sparkles:`
as minor, `:arrow_up:` and `:recycle:` as patch, and `Update README.md` flagged
as an unrecognized subject counted as a patch. No tag was created; the plan job
writes nothing.

`semver.ts` and `gitmoji.ts` were checked case by case, including the ones most
likely to be wrong:

| Case | Result |
| --- | --- |
| `3.0.0-beta.2` + patch / minor / major | `3.0.0` in all three — a prerelease is *on the way to* its version, not before the next one |
| `1.2.0-beta.1` + patch vs `1.2.3-beta.1` + patch | `1.2.0` vs `1.2.4` — the prerelease is only absorbed when the parts below the bump are zero |
| `1.0.0+build`, `1.0`, `x` | rejected rather than coerced |
| `:bug: Fix the :boom: handler` | `patch` — only the *first* token classifies, so a gitmoji in prose cannot force a major |
| `💥` vs `:boom:` | both `major` |
| `:wrench: Declare engines.node >=22` | `none` — the documented sharp edge |
| the same, with a `BREAKING CHANGE:` body trailer | `major` |

Plus `tsc --noEmit` over `scripts/`, and `publish.yml`, `action.yml` and both new
callers parsed as YAML.

**Not verified, and each needs a runner or the registry:** the OIDC exchange with
npm, and with it the claim that a reusable workflow validates against the
*caller's* filename (documented by npm, untested here); the environment approval
gate; the `contents: write` push against a `pr-required` branch with the Actions
app as a bypass actor; and `publish.ts` end to end, which has never run. The
first release of the first package is the real test of all five — do it with
`dry-run: true` first, which exercises everything except the four mutations.
