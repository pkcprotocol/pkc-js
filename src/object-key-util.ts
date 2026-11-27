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
//
// The list is fixed on purpose. Which records are valid is a protocol rule that every implementation must agree on, in
// any language and on any JavaScript engine, so it cannot depend on what Object.prototype happens to hold in this
// process (`key in Object.prototype` did: an engine or a polyfill adding a member would have made records invalid
// here that are valid everywhere else). The names below are every member of Object.prototype in ECMAScript that does
// not start with an underscore; the underscore ones (`__proto__`, `__defineGetter__`, ...) are covered where the
// underscore prefix is forbidden as a whole (isForbiddenRecordKey), and `__proto__` is listed for the callers of this
// function that have no such rule (sort names).
export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set([
    "__proto__",
    "constructor",
    "prototype",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "toLocaleString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__"
]);

export function isReservedObjectKey(key: string): boolean {
    return RESERVED_OBJECT_KEYS.has(key);
}

// The one rule for every name a record brings from the wire: a member of a record or of its `author`, and a sort name.
// The underscore prefix is how private members are named, so it is refused as a whole.
export function isForbiddenWireName(name: string): boolean {
    return name.startsWith("_") || RESERVED_OBJECT_KEYS.has(name);
}
