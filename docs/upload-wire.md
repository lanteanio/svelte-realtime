# Upload wire format v1

`live.upload()` streams share the realtime WebSocket with JSON RPC (first byte
`0x7B`) and binary RPC (first byte `0x00`). This document is the contract a
client outside the browser (a command-line uploader, a test harness, another
language) implements; the browser client in `svelte-realtime/client` follows it
exactly. Integers are unsigned and big-endian. A stream ID is chosen by the
client, scoped to its connection, and must not be reused while that upload is
active.

The exact frames in [upload-wire-v1.json](upload-wire-v1.json) are executed
against the real server dispatcher by `test/upload-flow.test.js`.

## Frame cap

The server announces the adapter's `maxPayloadLength` as a `__cap` number on the
first envelope it sends to a connection, whichever comes first: an RPC response
(topic `__rpc`) or an upload envelope (topic `__upload`). It is the limit for a
whole WebSocket message, upload header included; a larger frame makes the
adapter close the connection with code 1009.

A client sizes frames from the most recent `__cap` it received on the current
connection and forgets it when the connection drops. Until a cap is known, use
frames of at most 12 KiB. A client that made any call before its first upload
therefore sends chunk 0 at the full cap; an upload that is the first message on
a connection learns the cap from the first credit grant and uses it from
chunk 1 on.

## Chunk frame (client to server)

| Bytes | Meaning |
| --- | --- |
| 0 | `0x01` |
| 1 | flags: bit 0 `hasArgs`, bit 1 `isLast`, bits 2-7 zero |
| 2..5 | stream ID, uint32 |
| 6..9 | sequence number, uint32, starting at 0, contiguous |
| 10..11 | chunk 0 only: header length in UTF-8 bytes, uint16 |
| 12.. | chunk 0 only: JSON header, then payload bytes |
| 10.. | later chunks: payload bytes |

Chunk 0 sets `hasArgs`; later chunks clear it. The last chunk sets `isLast`; an
empty upload is a single chunk 0 with `isLast` and no payload. A frame with a
reserved flag bit set is dropped. Per-chunk overhead is 10 bytes, plus 2 bytes
and the header on chunk 0.

The chunk 0 header selects the mode:

- `{ "path": "module/fn", "args": [...] }` requests receiver credits.
- `{ "rpc": "module/fn", "args": [...] }` is the format without credits.

`args` holds the extra arguments of the upload call and may be omitted when
there are none. A header naming both `path` and `rpc` is rejected.

## Server envelopes (server to client)

The server answers on topic `__upload` with the stream ID as eight lowercase
hexadecimal characters for the event. The data is one of:

- `{ "ok": true, "data": <handler result> }` - terminal success.
- `{ "ok": false, "code": "...", "error": "..." }` - terminal failure.
- `{ "flow": 1, "creditEnd": N }` - a credit grant; not terminal.

Any envelope may also carry `__cap`. Ignore fields you do not know. A terminal
envelope can arrive before the sender has sent its last chunk: a handler may
return early, and later chunks for a settled stream are dropped.

## Receiver credits

In credit mode, `creditEnd` is an exclusive bound on sequence numbers: the
sender may send sequence numbers below the largest `creditEnd` it has received.
The bound starts at 1, so the sender sends chunk 0 and then waits. The server
grants credits only after authorization succeeded, and grants more as the
handler consumes `ctx.stream`, so at most `maxBufferedChunks` chunks (default
64) wait in the server's queue. Grants are cumulative: a duplicate or smaller
`creditEnd` adds nothing. A grant is sent once at least half the window is
free, so a sender whose handler keeps up rarely waits.

A chunk at or past the granted bound fails the upload with `FLOW_BACKPRESSURE`
(`upload chunk exceeds receiver credit`). Respect the local send buffer too;
the browser client also pauses while the WebSocket's `bufferedAmount` is high.

Without credits, the sender paces only on its own send buffer and the server
fails the upload with `FLOW_BACKPRESSURE` once `maxBufferedChunks` chunks are
queued ahead of the handler.

## Servers without credit support

A server that predates credits answers a `path` header with the terminal
failure `{ "ok": false, "code": "INVALID_REQUEST", "error": "missing rpc path" }`
before it resolves the endpoint or runs any guard. A sender that receives
exactly this as the first envelope of a credit-mode upload resends the upload
from chunk 0 with an `rpc` header under the same stream ID, and uses the `rpc`
header for later uploads on that connection. Guards and middleware run for the
resent upload as for any other.

## Cancel frame (client to server)

Six bytes: `0x02`, `0x10`, then the stream ID as uint32. The server aborts the
handler's signal and answers with a terminal `CANCELLED` failure. A sender
waiting for credits stops waiting when it cancels, when the connection drops,
and when a terminal envelope arrives.

## Test vectors

| Name | Frame |
| --- | --- |
| `first` | chunk 0 of stream 1 in credit mode for `files/save`, payload `00 01 02` |
| `last` | chunk 1 of stream 1, `isLast`, payload `03 fe ff`; send only after a grant with `creditEnd` of at least 2 |
| `cancel` | cancels stream 1 |
| `legacy` | a complete one-chunk upload, stream 2, `rpc` header, payload `00 01 02` |

`first` then `last` delivers the bytes `00 01 02 03 fe ff` to the handler.
Sending `last` before any grant fails stream 1 with `FLOW_BACKPRESSURE`.
