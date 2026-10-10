# Contributing

Start with a small reproducible outcome and the smallest change that proves it.
Use the [bug report](https://github.com/lanteanio/svelte-realtime/issues/new?template=bug_report.yml)
or [feature request](https://github.com/lanteanio/svelte-realtime/issues/new?template=feature_request.yml)
form. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Local setup

Use Node 22 or newer and npm. Clone the repository, run `npm ci`, and run
`npm run check`. The package ships source directly; there is no root build step.
`npm test` runs the checks first, then the unit suite. For one test while editing,
use `npx vitest run test/<name>.test.js`; the focused command does not replace
`npm test` before review. On Windows PowerShell use `npm.cmd` and `npx.cmd` if
execution policy blocks the PowerShell shims.

The browser suites require `npx playwright install chromium`. DevTools uses
`npm run test:devtools`. Application E2E tests use `npm ci --prefix test/fixture`
then `npm run test:e2e`. The fixture starts its own development and production
servers. Tests that use the native adapter require a supported uWebSockets.js
binary. State your Node version, OS, architecture, addon availability, exact
commands and omitted checks in the pull request; a skipped native test is not
evidence of native runtime coverage.

## Changes and review evidence

Use concise imperative commit subjects describing behavior. A conventional-commit
prefix and a Signed-off-by trailer are optional; no DCO signoff is required.
Do not include credentials or private deployment information in commits or logs.
A pull request explains the problem, resulting behavior, reproduction, verification
commands and results, compatibility impact, and a practical rollback.

Fixes need a regression that fails before the fix when practical. Documentation
and mechanical changes can use the relevant deterministic check. Public API
changes update declarations and examples with runtime behavior. Wire changes
also update `protocol.schema.json` and relevant vectors. Hot-path changes include
before/after measurements and the exact harness. Record intentional limitations
and checks that could not run rather than treating them as passes.

Add user-visible changes under `CHANGELOG.md` Unreleased. Describe compatibility
impact using semver: fixes preserve the contract, additions preserve existing
calls, and breaking changes require migration guidance. Maintainers choose the
release version and prerelease tag; do not bump the version merely to open a PR.
Keep dependency changes and their root or fixture lockfiles together. Use npm to
update lockfiles, review the resolved diff, and do not hand-edit generated lock data.

Generated error and onboarding references declare their generator in their
headers. Run `npm run generate:errors` or the documented onboarding generator,
then review the generated diff. Update simulation goldens only for an intentional
behavior change, recording the seed and rationale. Never bless a failing result
just to make a check green.

## Formatting

`.editorconfig` is the formatting contract. Preserve the surrounding indentation
where a file has no explicit indent rule. npm JSON files use two spaces; the
formatting checker and its tests use tabs. Markdown permits trailing spaces for
hard breaks. `npm run check:format` reads the ordered EditorConfig sections and
checks tracked text without rewriting files. It checks UTF-8, final newlines,
trailing whitespace, declared indentation and committed line endings from
`git ls-files --eol`, so a CRLF working copy does not produce false failures.
New files must be added to the Git index before this tracked-file check sees them.

## Small first contributions

The following bounded changes are useful starting points after confirming the
problem on the current branch: a broken documentation link with a link-check
regression, an error message with a minimal reproduction, or a missing example
for an existing typed API. Choose an issue only after confirming its acceptance
criteria and that nobody else is implementing it. A maintainer applies a
`good first issue` label only when scope, expected behavior, relevant files,
verification and an available reviewer are explicit; the label is not a promise
that arbitrary open issues are suitable for beginners.
