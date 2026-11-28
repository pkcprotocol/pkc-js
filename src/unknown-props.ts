// A loaded record can carry props this client's schema does not know yet (a newer protocol field), and
// those are copied onto the instance so they stay readable. Copying them with a bare Object.assign let a
// record name a prop like a member of the instance (a method such as `update`, a private field such as
// `_clientsManager`, `__proto__`) and replace that member on every reader that loaded it.
//
// Dependency-free on purpose: schema modules and runtime modules may both import it.

import { isForbiddenWireName, isReservedObjectKey } from "./object-key-util.js";

// The names each target received from records, so a later record may update them (`tip: 1` then `tip: 2`).
// A name the instance had before any record data touched it is a member, and is never in this set.
const namesAssignedFromRecords = new WeakMap<object, Set<string>>();

// A key a record may never carry, at the top level or inside its `author` object. A reader copies unknown props onto
// the instance and merges `author` into comment.author, so a key that means something to an object, or that is
// private by name, makes the record invalid at the gate (the loaders refuse it as well, for a record that never went
// through a gate). Names of the members of an instance are covered by the reserved-field lists, not by this rule.
// The set is frozen (see RESERVED_OBJECT_KEYS): the underscore prefix, plus a fixed list of names.
export function isForbiddenRecordKey(name: string): boolean {
    return isForbiddenWireName(name);
}

export function forbiddenKeysOf(record: unknown): string[] {
    if (typeof record !== "object" || record === null) return [];
    return Object.keys(record).filter(isForbiddenRecordKey);
}

// A copy of the record without its forbidden keys, for the places that spread a record into a runtime object
export function withoutForbiddenKeys<T extends object>(record: T): T {
    return <T>Object.fromEntries(Object.entries(record).filter(([name]) => !isForbiddenRecordKey(name)));
}

// The embedded authors of a crosspost chain (outermost first) that carry a forbidden key. Iterative: the depth of a
// chain is chosen by whoever signs it, and nothing here may depend on a cap having been enforced already.
export function forbiddenAuthorKeysInCrosspostChain(record: { crosspost?: unknown }): { level: number; keys: string[] }[] {
    const found: { level: number; keys: string[] }[] = [];
    let level = 0;
    for (
        let crosspost = <{ comment?: { author?: unknown; crosspost?: unknown } } | undefined>record.crosspost;
        crosspost && typeof crosspost === "object";
        crosspost = <{ comment?: { author?: unknown; crosspost?: unknown } } | undefined>crosspost.comment?.crosspost
    ) {
        level++;
        const keys = forbiddenKeysOf(crosspost.comment?.author);
        if (keys.length > 0) found.push({ level, keys });
    }
    return found;
}

export type AssignUnknownPropsResult = { assigned: string[]; skipped: string[] };

function isBlockedName({ target, name }: { target: object; name: string }): boolean {
    // Local safety, not a protocol rule: what may be copied onto this instance is decided against the instance itself,
    // so a member an engine or a polyfill adds later is protected here without making any record invalid
    if (isReservedObjectKey(name)) return true;
    // No private member can be set from a record, whether or not the instance holds it yet
    if (name.startsWith("_")) return true;
    // Own or inherited, Object.prototype included (toString, hasOwnProperty, ...): that is a member
    if (name in target) return !namesAssignedFromRecords.get(target)?.has(name);
    return false;
}

// Copies the props of `record` that are not in `knownKeys` onto `target`, skipping any name that would replace
// a member of `target`. Returns what it did so a caller can log the skipped names.
export function assignUnknownProps({
    target,
    record,
    knownKeys
}: {
    target: object;
    record: object;
    knownKeys: Iterable<string>;
}): AssignUnknownPropsResult {
    const known = new Set(knownKeys);
    const assigned: string[] = [];
    const skipped: string[] = [];
    for (const name of Object.keys(record)) {
        if (known.has(name)) continue;
        const value = (<Record<string, unknown>>record)[name];
        // Defining (not assigning) keeps `__proto__` and accessor names from running a setter
        if (isBlockedName({ target, name }) || typeof value === "function") {
            skipped.push(name);
            continue;
        }
        Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
        let names = namesAssignedFromRecords.get(target);
        if (!names) namesAssignedFromRecords.set(target, (names = new Set()));
        names.add(name);
        assigned.push(name);
    }
    return { assigned, skipped };
}

// Merges the `author` object of a record into a plain-object author. Every field the schema knows is merged,
// so only names that mean something to an object are refused: a prototype name, anything starting with `_`,
// and any name Object.prototype already has (toString, hasOwnProperty, ...).
export function mergeAuthorProps({ target, props }: { target: object; props: object }): { skipped: string[] } {
    const skipped: string[] = [];
    for (const name of Object.keys(props)) {
        if (isForbiddenRecordKey(name)) {
            skipped.push(name);
            continue;
        }
        Object.defineProperty(target, name, {
            value: (<Record<string, unknown>>props)[name],
            writable: true,
            enumerable: true,
            configurable: true
        });
    }
    return { skipped };
}
