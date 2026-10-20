# Localized error display

`LiveError.code` is the stable application-facing identifier. `message` is a
source-English display fallback; it is not a translation key. Translate codes
and structured parameters in your application, keeping wording and locale
selection out of server handlers.

```js
import { LiveError } from 'svelte-realtime/server';
throw new LiveError('ITEM_LIMIT', 'Only 3 items are allowed', {
  params: { count: 3 },
  details: { field: 'items' }
});
```

The third argument accepts optional `params` (a JSON object) and `details` (any
JSON value). Both fields are public: include only information intended for the
caller. The framework never infers metadata from a message, a cause, or arbitrary
error properties. Ordinary server errors remain masked as `INTERNAL_ERROR`.
Authentication and authorization checks still decide who can receive a result.

Create this app-owned resolver, then import it in components as
`$lib/error-text`. Add your own codes and connect the locale argument to your
application's locale store. The resolver validates parameters before formatting
and uses a generic localized message for unknown codes rather than displaying
unexpected server text.

```js
// src/lib/error-text.js
export function errorText(error, locale = 'en') {
  const german = locale.startsWith('de');
  if (error?.code === 'ITEM_LIMIT' && Number.isSafeInteger(error.params?.count)
      && error.params.count >= 0) {
    const count = new Intl.NumberFormat(locale).format(error.params.count);
    return german ? `Maximal ${count} Einträge sind erlaubt.` : `At most ${count} items are allowed.`;
  }
  if (error?.code === 'UNAUTHENTICATED') {
    return german ? 'Bitte anmelden.' : 'Please sign in.';
  }
  return german ? 'Bitte erneut versuchen.' : 'Please try again.';
}
```

An English-only application may deliberately use `error.message` as its fallback
for recognized application errors. Render strings as text; never insert error
messages or parameters as HTML. `details` can drive field highlighting while
`params` supplies translation interpolation values. `RpcError` accepts the same
optional third constructor argument for errors constructed by application code.

## Transport and compatibility

Ordinary RPC, stream initialization, batches, binary RPC, and streaming uploads
carry `params` and `details` as optional sibling fields beside the existing
`code` and `error`. Clients expose them on `RpcError`. Direct server calls retain
them on `LiveError`; `realtimeTransport()` preserves them through SSR hydration.
Validation `issues` keep their existing shape and tuple position.

A new client accepts old replies without metadata. Old clients ignore the added
fields and keep the original code and English fallback. The SSR preset appends
metadata after existing tuple elements, so old decoders ignore it and new
decoders accept the shorter tuples. No protocol revision or coordinated client
upgrade is required.

## Bounds

Metadata is copied and nested objects are frozen when an error is constructed;
mutating the original input cannot change the public payload. Each transport
validates again before sending. Together, the serialized `{ params, details }`
object must fit 4096 UTF-8 bytes, at most 128 visited values and eight nested
levels. Parameter keys count toward the byte bound. Dates, class instances,
accessors, serialization hooks, sparse arrays, cycles, bigint, symbols,
functions, non-finite numbers and prototype-related keys are not accepted.
Optional fields may be omitted or undefined.

If either supplied field is invalid or the combined bound is exceeded, both
metadata fields are omitted. Code and message still propagate, so callers can
always use their normal fallback. These bounds apply to structured metadata;
the existing message and transport frame behavior is unchanged.
