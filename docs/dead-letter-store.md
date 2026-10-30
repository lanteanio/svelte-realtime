# Dead-letter stores

`configureWebhooks({ deadLetter })` takes `true` for the built-in in-memory store (`createDeadLetterStore({ max, ttlMs, forgetUserId })`) or a store instance. A cluster substitutes a durable Redis/Postgres store with the same interface; every `DeadLetterStore` method may return a promise. `add` returns a record ID or `null` when an erasure tombstone suppresses capture.

## Capture keys and receipts

Each capture carries a `key`: the lowercase hex SHA-256 of the JSON array `[webhookId, topic, event, data]` with object keys sorted, so one failed delivery is one record (the same delivery's idempotency-key identity) and a write whose reply was lost can be repeated safely. While a keyed record is retained, an `add` with the same key and content returns its ID without writing - that ID is the receipt - and an `add` with the same key but different content throws `DEAD_LETTER_KEY_CONFLICT`. A key is released with its record (replay, `remove`, eviction, TTL, `purgeUser`, `clear`); erasure tombstones still apply to repeated writes.

A store opts into keys by exposing `keyedAdd: true`; the built-in store does. A store without it receives no `key` and exactly one `add` per capture, because repeating a write it cannot deduplicate could store the event more than once. When `add` on a keyed store throws or rejects, capture repeats the keyed write after 100 ms and 500 ms. If every attempt fails, or the key conflicts, the event is lost, the `webhook.dead-letter.persist-failed` operational event fires with the webhook id (never the payload), and `svelte_realtime_webhook_dead_letter_failures_total` counts it.
