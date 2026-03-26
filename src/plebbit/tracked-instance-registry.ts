export class TrackedInstanceRegistry<T extends object> {
    private readonly _entries = new Map<T, Set<string>>();
    private readonly _aliases = new Map<string, Set<T>>();

    constructor() {
        return new Proxy(this, {
            deleteProperty: (target, property) => {
                if (typeof property === "string" && !Reflect.has(target, property)) {
                    const trackedValue = target.findByAlias(property);
                    if (trackedValue) target.untrack(trackedValue);
                    return true;
                }
                return Reflect.deleteProperty(target, property);
            },
            get: (target, property) => {
                if (typeof property === "string" && !Reflect.has(target, property)) return target.findByAlias(property);
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
            getOwnPropertyDescriptor: (target, property) => {
                if (typeof property === "string" && !Reflect.has(target, property)) {
                    const trackedValue = target.findByAlias(property);
                    if (trackedValue) {
                        return {
                            configurable: true,
                            enumerable: true,
                            value: trackedValue,
                            writable: true
                        };
                    }
                }
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
            has: (target, property) => {
                if (typeof property === "string" && !Reflect.has(target, property)) return target.findByAlias(property) !== undefined;
                return Reflect.has(target, property);
            },
            ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...target.aliases()])],
            set: (target, property, value) => {
                if (typeof property === "string" && !Reflect.has(target, property)) {
                    if (typeof value !== "object" || value === null) return false;
                    target.track({ value: value as T, aliases: [property] });
                    return true;
                }
                return Reflect.set(target, property, value, target);
            }
        });
    }

    track(opts: { value: T; aliases?: Iterable<string> }): T {
        if (!this._entries.has(opts.value)) this._entries.set(opts.value, new Set());
        if (opts.aliases) this.addAliases(opts.value, opts.aliases);
        return opts.value;
    }

    addAliases(value: T, aliases: Iterable<string>): void {
        const entry = this._entries.get(value);
        if (!entry) throw new Error("Cannot add aliases for an untracked value");

        for (const alias of aliases) {
            if (typeof alias !== "string" || alias.length === 0 || entry.has(alias)) continue;
            entry.add(alias);

            const trackedValues = this._aliases.get(alias);
            if (trackedValues) trackedValues.add(value);
            else this._aliases.set(alias, new Set([value]));
        }
    }

    untrack(value: T): void {
        const aliases = this._entries.get(value);
        if (!aliases) return;

        for (const alias of aliases) {
            const trackedValues = this._aliases.get(alias);
            if (!trackedValues) continue;

            trackedValues.delete(value);
            if (trackedValues.size === 0) this._aliases.delete(alias);
        }

        this._entries.delete(value);
    }

    has(value: T): boolean {
        return this._entries.has(value);
    }

    findByAlias(alias: string): T | undefined {
        const trackedValues = this._aliases.get(alias);
        if (!trackedValues || trackedValues.size === 0) return undefined;
        if (trackedValues.size > 1) {
            throw new Error(`Tracked instance registry invariant violated for alias "${alias}"`);
        }
        return trackedValues.values().next().value;
    }

    findByAliases(aliases: Iterable<string>): T | undefined {
        const matches = new Set<T>();

        for (const alias of aliases) {
            const match = this.findByAlias(alias);
            if (match) matches.add(match);
        }

        if (matches.size === 0) return undefined;
        if (matches.size > 1) throw new Error("Tracked instance registry invariant violated for lookup");
        return matches.values().next().value;
    }

    values(): T[] {
        return [...this._entries.keys()];
    }

    aliases(): string[] {
        return [...this._aliases.keys()];
    }

    size(): number {
        return this._entries.size;
    }
}

export type IndexedTrackedInstanceRegistry<T extends object> = TrackedInstanceRegistry<T> & Record<string, T | undefined>;
