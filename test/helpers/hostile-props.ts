// Shared by the unknown-prop collision suites. An unknown prop on a loaded record is copied onto the
// instance; these helpers build the names a record could use to collide with a member of that instance.
// The table comes from the live instance, so a member added later is covered without touching a test.

export const HOSTILE_VALUE = "hostile value";

// Dangerous because of what the prototype machinery does with them, not because an instance holds them
export const PROTOTYPE_NAMES = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

// Private fields named in the report and in the review of PR #534, kept so the table never loses them
export const KNOWN_PRIVATE_NAMES = ["_clientsManager", "_wasPublishCalled", "_publishEndedBy", "_updateAttempt"];

// Every string key of the instance, own and inherited, up to but excluding Object.prototype
export function memberNamesOf(instance: object): string[] {
    const names = new Set<string>();
    for (let o: object | null = instance; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
        for (const key of Reflect.ownKeys(o)) if (typeof key === "string") names.add(key);
    return [...names];
}

export function hostileNamesFor({ instance, knownKeys }: { instance: object; knownKeys: Iterable<string> }): string[] {
    const known = new Set(knownKeys);
    return [...new Set([...memberNamesOf(instance).filter((name) => !known.has(name)), ...PROTOTYPE_NAMES, ...KNOWN_PRIVATE_NAMES])];
}

// A computed key makes "__proto__" an own property and the JSON round trip keeps it one, as a record
// parsed off the wire would have it (an object literal `{ __proto__: x }` would set the prototype instead)
export function recordWith<T extends object>({ record, name, value }: { record: T; name: string; value?: unknown }): T {
    return <T>JSON.parse(JSON.stringify({ ...record, [name]: value === undefined ? HOSTILE_VALUE : value }));
}

// The value to plant under a name: for __proto__ an object carrying a marker, so pollution is detectable
export function valueFor(name: string): unknown {
    return name === "__proto__" ? { polluted: true } : HOSTILE_VALUE;
}

export function objectPrototypeIsClean(): boolean {
    return ({} as Record<string, unknown>).polluted === undefined;
}

// Calls instance.stop() and reports what went wrong as a string, so one broken instance does not end a loop
// of soft assertions. undefined means it resolved.
export async function stopOutcome(instance: object): Promise<string | undefined> {
    try {
        await (<{ stop: () => Promise<void> }>instance).stop();
        return undefined;
    } catch (e) {
        return (<Error>e).message;
    }
}

// Collects the errors that would have terminated a Node process (an uncaught exception, or an unhandled rejection,
// which Node turns into one by default). A listener makes the process survive, so the test can assert on what a
// production process would have died of. vitest also reports them as unhandled errors; this makes the assertion explicit.
export function captureProcessFatalErrors(): { errors: string[]; stop: () => void } {
    const errors: string[] = [];
    const onError = (e: unknown) => errors.push(e instanceof Error ? e.message : String(e));
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
    return {
        errors,
        stop: () => {
            process.off("uncaughtException", onError);
            process.off("unhandledRejection", onError);
        }
    };
}
