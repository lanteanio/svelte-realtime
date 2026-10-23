# SvelteKit compatibility fixtures

Install the root development dependencies and both locked fixture trees:

```sh
npm ci
npx playwright install chromium
npm ci --prefix test/fixtures/kit2
npm ci --prefix test/fixtures/kit3
```

Run all browser and WebSocket combinations in sequence (eight, plus two
lowercase-drive cases on Windows):

```sh
npm run test:kit
```

Run one combination while developing:

```sh
node test/kit-compat/run.mjs --kit 2 --mode production
node test/kit-compat/run.mjs --kit 2 --mode dev --hmr
node test/kit-compat/run.mjs --kit 3 --mode production
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr
node test/kit-compat/run.mjs --kit 2 --mode dev --no-devtools
node test/kit-compat/run.mjs --kit 3 --mode dev --no-devtools
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr --adapter wrapped
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr --adapter none
node test/kit-compat/run.mjs --kit 3 --mode production --drive-case lower
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr --drive-case lower
```

The runner uses each fixture's own Vite binary and an OS-assigned port.
Startup is ready once a WebSocket opens and the fixture's `open` hook sends the
spawned process ID and a fresh per-run token; another server on the port
cannot satisfy it. Attempts are retried only until a socket opens, since Vite 8
briefly listens on the port to check that it is free and then initializes
before it binds for real. Startup makes no RPC and no page request, so the
cold check below makes the first RPC on the fresh server.
Production runs remove old build output and rebuild before starting the generated server.
Development runs force dependency optimization, then
open a WebSocket and execute an RPC before the first HTTP request. The browser
loads generated `$live` imports, checks an RPC response on the wire, and observes
a server-published value in two independent page stores. An HTTP endpoint reads
the same server state. A module-scope private environment import verifies server
initialization with the harmless value `fixture-secret`.

Devtools checks require the runtime object and overlay to load in development.
Production and `--no-devtools` runs require both to be absent. `--hmr` replaces a
handler, removes another, and checks both RPC results and live store delivery.
That single edit must reload the registry exactly once, even when Vite reports
the file under more than one path spelling.
A route-only edit then verifies the updated HTTP response, fresh WebSocket RPC,
and matching stores in both pages. Adding and removing a live file must update
the RPC registry and preserve shared HTTP and WebSocket state. Kit 3 development also covers a renamed
adapter and a configuration without an inline adapter.
On Windows, `--drive-case lower` starts Vite from the fixture path with a
lowercase drive letter, as a VS Code terminal often does. SvelteKit keeps that
spelling while Vite 8 resolves its root to the uppercase one, so a module
imported under both would run twice. The run first checks that the two
spellings really differ, then requires routes and live handlers to share state.
The edited sources are restored byte for byte even on failure. Run only one
compatibility command at a time per fixture.

Each run writes named pass/fail checks and captured server output to
`test-results/kit-compat-<major>-<mode>.json`. Use `--report <path>` for a distinct
output file. Failures return a nonzero exit code; assertions are never skipped.
The named checks let mutation runs distinguish an assertion failure from a
startup or dependency failure. A WebSocket handler that cannot load counts as a
startup failure in development too, as it always has in production.


The scaffolder smoke uses a loopback npm registry to serve candidate archives.
All other packages resolve from the normal npm registry, and strict peer
resolution stays enabled. It creates an isolated npm project, invokes the real
CLI, builds the generated app, and checks counter updates in two browsers in
production and development.

```sh
npm pack --pack-destination test-results
npm run test:scaffold -- --adapter-pack /path/to/svelte-adapter-uws-0.5.11.tgz --realtime-pack test-results/svelte-realtime-0.5.14.tgz
```

Add `--explicit-package` to exercise the npm exec package-option form too.
Scaffold logs and results are saved under `test-results/scaffold-<timestamp>/`.
When running Playwright's other suites, use `--output=test-results/e2e-artifacts`
so its cleanup preserves these reports.
