# SvelteKit compatibility fixtures

Install the root development dependencies and the three locked fixture trees:

```sh
npm ci
npx playwright install chromium
npm ci --install-links --prefix test/fixtures/kit2
npm ci --install-links --prefix test/fixtures/kit2-vite5
npm ci --install-links --prefix test/fixtures/kit3
```

`kit2` runs SvelteKit 2 on Vite 6 and `kit3` runs SvelteKit 3 on Vite 8.
`kit2-vite5` runs SvelteKit 2 on Vite 5, the oldest Vite the Kit 2 peer range
admits; select it with `--kit 2 --vite 5`.

Run all browser and WebSocket combinations in sequence (ten, plus two
lowercase-drive cases on Windows):

```sh
npm run test:kit
```

Run one combination while developing:

```sh
node test/kit-compat/run.mjs --kit 2 --mode production
node test/kit-compat/run.mjs --kit 2 --mode dev --hmr
node test/kit-compat/run.mjs --kit 2 --vite 5 --mode production
node test/kit-compat/run.mjs --kit 2 --vite 5 --mode dev --hmr
node test/kit-compat/run.mjs --kit 3 --mode production
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr
node test/kit-compat/run.mjs --kit 2 --mode dev --no-devtools
node test/kit-compat/run.mjs --kit 3 --mode dev --no-devtools
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr --adapter wrapped
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr --adapter none
node test/kit-compat/run.mjs --kit 3 --mode production --drive-case lower
node test/kit-compat/run.mjs --kit 3 --mode dev --hmr --drive-case lower
```

Each fixture installs this checkout as a packed copy, so repeat its
`npm ci --install-links` after changing `src/`; the runner refuses a fixture
whose installed copy differs from the checkout. All fixtures use
svelte-adapter-uws 0.6.0-next.96 from the registry.

The runner uses each fixture's own Vite binary and an OS-assigned port.
Readiness requires the fixture's `/readiness` route to return the spawned
process ID and a fresh per-run fixture token; an unrelated listener cannot
satisfy startup. The route loads no live module and no page.
Production runs remove old build output and rebuild before starting the generated server.
Development runs force dependency optimization, then
open a WebSocket and execute the first RPC before any page loads. The browser
loads generated `$live` imports, checks an RPC response on the wire, and observes
a server-published value in two independent page stores. An HTTP endpoint reads
the same server state. A module-scope private environment import verifies server
initialization with the harmless value `fixture-secret`.

Devtools checks require the runtime object and overlay to load in development.
Production and `--no-devtools` runs require both to be absent. `--hmr` replaces a
handler, removes another (the server masks a call to it as `FORBIDDEN`), and
checks both RPC results and live store delivery. Browser console output is
captured with the server output, and HMR must not emit the Cloudflare Tunnel
cookie warning for normal server restarts.
That single edit must reload the registry exactly once, even when Vite reports
the file under more than one path spelling.
A route-only edit then verifies the updated HTTP response, fresh WebSocket RPC,
and matching stores in both pages. Adding and removing a live file must update
the RPC registry and preserve shared HTTP and WebSocket state. A syntax error
saved into a live module must report a failed reload while the previous
handlers keep serving, and the repaired save must register the new handlers
without splitting state. Editing `src/hooks.ws.js` must load the new upgrade
hook on fresh connections while live handlers and shared state survive; deleting
it and creating it again must do the same. Kit 3 development also covers a renamed
adapter and a configuration without an inline adapter.
On Windows, `--drive-case lower` starts Vite from the fixture path with a
lowercase drive letter, as a VS Code terminal often does. SvelteKit keeps that
spelling while Vite 8 resolves its root to the uppercase one, so a module
imported under both would run twice. The run first checks that the two
spellings really differ, then requires routes and live handlers to share state.
The edited sources are restored byte for byte even on failure. Run only one
compatibility command at a time per fixture.

Registry work has a 30-second caller deadline. An import that outlives that
deadline keeps the internal queue occupied until it settles; newer writes
cannot interleave with its eventual registration. Writes that time out before
starting can be retried by saving again. Fix or restart a permanently stalled
dev server; the timeout does not cancel module evaluation.

Each run writes named pass/fail checks and captured server output to
`test-results/kit-compat-<major>[-vite5]-<mode>.json`. Use `--report <path>` for a distinct
output file. Failures return a nonzero exit code; assertions are never skipped.
The named checks let mutation runs distinguish an assertion failure from a
startup or dependency failure.

The matrix lists checks that fail because of the installed svelte-adapter-uws
version, each with the adapter version and the adapter behaviour that causes
it. A run that fails only those checks is reported as a known adapter failure,
together with the checks it did not reach; the matrix still exits nonzero for
any other failure. An entry applies only to its adapter version, and a known
failure that passes is printed so the entry can be removed.

The scaffolder smoke uses a loopback npm registry to serve candidate archives.
All other packages resolve from the normal npm registry, and strict peer
resolution stays enabled. It creates an isolated npm project, invokes the real
CLI, builds the generated app, and checks counter updates in two browsers in
production and development.

```sh
npm pack --pack-destination test-results
npm pack svelte-adapter-uws@0.6.0-next.96 --pack-destination test-results
npm run test:kit-scaffold -- --adapter-pack test-results/svelte-adapter-uws-0.6.0-next.96.tgz --realtime-pack test-results/svelte-realtime-<version>.tgz
```

Add `--explicit-package` to exercise the npm exec package-option form too.
Scaffold logs and results are saved under `test-results/scaffold-<timestamp>/`.
When running Playwright's other suites, use `--output=test-results/e2e-artifacts`
so its cleanup preserves these reports.
