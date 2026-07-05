// Signer section

import type { CreatePublicationOptions } from "../types.js";

// `as const` (a readonly literal tuple) is required so remeda v2's `omit`/`pick` — whose key
// params are typed `const Keys extends readonly KeysOfUnion<T>[]` — remove exactly these keys at
// the type level. A plain `(...)[]` array degrades them to optional/leaked keys, which cascades
// through the `*SignedPropertyNames = keys(omit(shape, ...))` types into the zod `.pick()` schemas.
export const keysToOmitFromSignedPropertyNames = [
    "signer",
    "challengeRequest",
    "communityAddress"
] as const satisfies readonly (keyof CreatePublicationOptions)[];
