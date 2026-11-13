// Keys that must never come from the wire into a plain-object map. This module MUST stay dependency-free: it is
// imported by zod schema modules (see src/domain-util.ts for why a schema module cannot import src/util.ts).
//
// Sort names are map keys on the client (`pages.clients[...][sortName]`, `pages.pages[sortName]`), so a record that
// names a sort `__proto__` would write through Object.prototype, and `constructor`/`prototype` resolve to inherited
// values instead of own entries. zod drops an own `__proto__` key without visiting it, so a key refine alone does not
// see it; the pages client manager skips these keys as well.
//
// Every other key a plain object inherits (`toString`, `hasOwnProperty`, `valueOf`, ...) is reserved for the same
// reason: `if (!clients[sortName]) clients[sortName] = {}` finds the inherited function instead of an empty slot, and
// the per-transport client state would then be hung on a function shared by every object in the process.
export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isReservedObjectKey(key: string): boolean {
    return RESERVED_OBJECT_KEYS.has(key) || key in Object.prototype;
}
