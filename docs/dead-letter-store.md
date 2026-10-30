# Dead-letter stores

`configureWebhooks({ deadLetter })` takes `true` for the built-in in-memory store (`createDeadLetterStore({ max, ttlMs, forgetUserId })`) or a store instance. A cluster substitutes a durable Redis/Postgres store with the same interface; every `DeadLetterStore` method may return a promise. `add` returns a record ID or `null` when an erasure tombstone suppresses capture.

## Capture keys and receipts

A store opts into capture keys by exposing `keyedAdd: true`; the built-in store does. Only then does a capture pass `key` to `add` and repeat a write whose outcome is unknown. A store without it receives no `key` and exactly one `add` per capture, because repeating a write it cannot deduplicate could store the event more than once.

The key is the `idempotency-key` header of the failed delivery: the value of the webhook's `idempotencyKey(event, data)` callback when one is configured, otherwise SHA-256 (HMAC-SHA-256 with the webhook `secret`) over the topic, the event and the JSON body the delivery sent, after `transform`. The queue therefore keeps one record per delivery a receiver would accept once. A delivery that failed before its key was computed (an open breaker, a failing `url` callback) derives it from the transformed payload. A delivery without a usable key (a `transform` that threw, a callback returning `null`, a value over 256 characters or with CR, LF or NUL) is captured unkeyed. A callback that throws or does not settle within `callbackTimeoutMs` is captured unkeyed as well and reported as `webhook.dead-letter.key-unavailable`. The key is derived from the webhook config as the delivery reads it, so it always matches the secret the delivery signed with, also after the registered config changes.

A store that declares `keyedAdd` must implement `add` as one atomic step:

| Step | Contract |
| --- | --- |
| Tombstone | An erasure tombstone for the record's user and tenant scope drops the add (`null`) before any key lookup, so a repeated capture of an erased user's event stays dropped. |
| Lookup | `key` is 1 to 256 characters and unique per `webhookId` and tenant scope of `topic` (the same scope the erasure tombstone uses), so a callback key that repeats across tenants never merges their records. When a retained record holds the same webhook, scope and key, return that record's ID and write nothing. The content of the repeat is not compared. |
| Insert | Otherwise insert the record, hold the key for it, and return the new ID. Concurrent adds with the same webhook, scope and key produce one record and one ID. |
| Release | A key is held exactly as long as its record: replay, `remove`, eviction, TTL expiry, `purgeUser` and `clear` release it. |
| Read | Records expose `key` (`null` for an unkeyed add). |

In Redis this is one script over a hash from webhook, scope and key to the record ID; in PostgreSQL a unique index on `(webhook_id, tenant_scope, capture_key)` with `INSERT ... ON CONFLICT DO NOTHING` followed by a read of the holder in the same transaction.

When `add` on a keyed store throws or rejects, capture repeats the keyed write after 100 ms and 500 ms. If every attempt fails, the event is lost, the `webhook.dead-letter.persist-failed` operational event fires with the webhook id (never the payload), and `svelte_realtime_webhook_dead_letter_failures_total` counts it.
