# Runtime error reference

This file is generated from the runtime-owned registry. Do not edit it by hand.
Runtime messages preserve the documented prefix and append the stable ID plus this package-local help route.

| Stable ID | Runtime code | Event | Message prefix |
|---|---|---|---|
| `REALTIME-ERR-INVALID-USER-ID` | `INVALID_USER_ID` | `ctx.signal.invalid-user-id` | `ctx.signal:` |
| `REALTIME-ERR-LIVE-RESOLVE` | - | `vite.live.resolve-failed` | `[svelte-realtime] Could not resolve $live/` |
| `REALTIME-ERR-UPLOAD-START-LIMIT` | `PAYLOAD_TOO_LARGE` | `upload.pending-size.exceeded` | `upload exceeds limit during start` |
| `REALTIME-ERR-UPLOAD-MAX-SIZE` | `PAYLOAD_TOO_LARGE` | `upload.max-size.exceeded` | `upload exceeds maxSize` |

<a id="realtime-err-invalid-user-id"></a>
## `REALTIME-ERR-INVALID-USER-ID`

- Runtime code: `INVALID_USER_ID`
- Event: `ctx.signal.invalid-user-id`
- Message prefix: `ctx.signal:`
- Cause: ctx.signal(userId, ...) received a value that is not a non-empty string of at most 256 characters, or it contains a control character, double quote, or backslash.
- Consequence: The signal is not published and the caller receives an INVALID_USER_ID LiveError.
- Automatic recovery: None; malformed identity input is not retried.
- Next action: Pass the canonical validated user ID used by enableSignals(). Do not retry the same malformed value.
- Runtime help: `docs/errors.md#realtime-err-invalid-user-id`
- Runtime sources: [`src/server/ctx.js`](../src/server/ctx.js)

<a id="realtime-err-live-resolve"></a>
## `REALTIME-ERR-LIVE-RESOLVE`

- Runtime code: none (build diagnostic)
- Event: `vite.live.resolve-failed`
- Message prefix: `[svelte-realtime] Could not resolve $live/`
- Cause: A $live/<module> virtual import has no matching JavaScript or TypeScript file under the configured live directory.
- Consequence: The requested virtual module cannot load, so development or the build stops at that import.
- Automatic recovery: Vite resolves the import again after the module graph changes or the command is rerun.
- Next action: Correct the import path, add the matching live module, or configure the live directory.
- Runtime help: `docs/errors.md#realtime-err-live-resolve`
- Runtime sources: [`src/vite/plugin.js`](../src/vite/plugin.js)

<a id="realtime-err-upload-start-limit"></a>
## `REALTIME-ERR-UPLOAD-START-LIMIT`

- Runtime code: `PAYLOAD_TOO_LARGE`
- Event: `upload.pending-size.exceeded`
- Message prefix: `upload exceeds limit during start`
- Cause: Upload bytes crossed the protected pending-phase cap before the endpoint handler and its options finished resolving.
- Consequence: The upload is aborted before its endpoint handler begins and returns PAYLOAD_TOO_LARGE.
- Automatic recovery: None; the aborted stream cannot be resumed.
- Next action: Reduce the initial or pending upload volume and retry with a new stream.
- Runtime help: `docs/errors.md#realtime-err-upload-start-limit`
- Runtime sources: [`src/server/upload.js`](../src/server/upload.js)

<a id="realtime-err-upload-max-size"></a>
## `REALTIME-ERR-UPLOAD-MAX-SIZE`

- Runtime code: `PAYLOAD_TOO_LARGE`
- Event: `upload.max-size.exceeded`
- Message prefix: `upload exceeds maxSize`
- Cause: The received upload bytes exceeded the maxSize configured by the resolved upload handler.
- Consequence: The upload is aborted and returns PAYLOAD_TOO_LARGE without invoking or completing the handler.
- Automatic recovery: None; the aborted stream cannot be resumed.
- Next action: Reduce the upload or deliberately raise the audited maxSize, then start a new upload.
- Runtime help: `docs/errors.md#realtime-err-upload-max-size`
- Runtime sources: [`src/server/upload.js`](../src/server/upload.js)
