# App-wide connection user types

For TypeScript apps, declare `Register.user` once to type `ctx.user`,
`ctx.ws.getUserData()`, live handlers, guards, and stream callbacks throughout
the app. Derive it from your upgrade hook so the two shapes stay in sync:

```ts
// src/app.d.ts
import 'svelte-realtime/server';
type UpgradeResult = Exclude<Awaited<ReturnType<typeof import('./hooks.ws').upgrade>>, false>;
type UnwrapUpgrade<U> = U extends { __upgradeResponse: true; userData: infer D } ? D : U;
type ConnectionUser = UnwrapUpgrade<UpgradeResult>;
declare module 'svelte-realtime/server' {
  interface Register { user: ConnectionUser }
}
```

Give `upgrade()` an explicit return type if it imports live modules, to avoid a
circular type dependency. Include anonymous users in that type when the hook
accepts anonymous connections. Registration is compile-time only; it does not
validate authentication data. Without registration, callbacks remain permissive;
`LiveContext<MyUser>` remains available for explicit context types. Generated
stream `.load(platform, { user })` options use the same registered type.

The derivation handles both plain user data and the adapter's
`upgradeResponse(userData, headers)` wrapper. `false` rejects the upgrade and is
excluded; the wrapper's `userData` is the accepted connection shape.
