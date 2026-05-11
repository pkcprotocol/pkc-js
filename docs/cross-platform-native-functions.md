# Cross platform native functions

`pkc-js` is written entirely in JavaScript and can run in both Node.js and the browser. A small set of functionalities needs a platform-specific implementation, so pkc-js ships a default `fetch` per environment and lets you override it (for example, when running inside Electron or an Android WebView with an injected native HTTP client).

## Current NativeFunctions surface

The type is defined in [src/types.ts](../src/types.ts):

```ts
export type NativeFunctions = {
  fetch: typeof fetch;
};
```

Today only `fetch` is overridable. Defaults are wired up in [src/index.ts](../src/index.ts) from `src/runtime/node/native-functions.ts` and `src/runtime/browser/native-functions.ts`, and the active platform is chosen by the bundler.

## Overriding the defaults

```js
import PKC, { setNativeFunctions, nativeFunctions } from '@pkcprotocol/pkc-js';

// Replace the default fetch (e.g. with a native HTTP bridge from Electron / WebView)
setNativeFunctions({ fetch: myNativeFetch });

// You can still inspect the platform-specific defaults
console.log(nativeFunctions.node.fetch);
console.log(nativeFunctions.browser.fetch);
```

`setNativeFunctions` accepts a partial object; only the keys you pass are overridden. Re-call it with `{}` is a no-op rather than a reset.

## TODO

- Define SQL native functions to be able to run a community on Android.
