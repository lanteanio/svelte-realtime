# Accepted first-run transcript

This generated page is the release acceptance contract for the non-interactive
newcomer route. Edit `src/cli-utils.js`, then regenerate; do not edit this page
by hand.

## Audited candidate tuple

- `svelte-adapter-uws@0.6.0-next.95`
- `svelte-realtime@0.6.0-next.91`
- `svelte-adapter-uws-extensions@0.6.0-next.64`
- `https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/v20.69.0.tar.gz`

The candidate versions must be published together before the registry command
is executable. Publication is deliberately separate from implementation review.

## Clean transcript

```text
Checking Node, OS, architecture, libc, and uWebSockets.js
preflight OK - Node, platform/libc, and the pinned native addon are ready.
Building the production app
Production build verified
Verified. cd my-app && npm run dev
First browser connection (expected until authentication is replaced):
[SR-ONBOARD-001] Scaffold authentication is still permissive: Every connection receives a random UUID. Replace upgrade() in src/hooks.ws.ts and delete SCAFFOLD_PLACEHOLDER before deployment.
```

The authentication warning is expected on the first browser connection until
the scaffold placeholder is replaced. No missing-message, ignored-config, native
ABI, or failed-build warning is accepted in this transcript.

## Warning contract

- Code: `SR-ONBOARD-001`
- Title: Scaffold authentication is still permissive
- Body: Every connection receives a random UUID. Replace upgrade() in src/hooks.ws.ts and delete SCAFFOLD_PLACEHOLDER before deployment.
