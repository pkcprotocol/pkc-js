export declare class TrackedInstanceRegistry<T extends object> {
    private readonly _entries;
    private readonly _aliases;
    constructor();
    track(opts: {
        value: T;
        aliases?: Iterable<string>;
    }): T;
    addAliases(value: T, aliases: Iterable<string>): void;
    untrack(value: T): void;
    has(value: T): boolean;
    findByAlias(alias: string): T | undefined;
    findByAliases(aliases: Iterable<string>): T | undefined;
    values(): T[];
    aliases(): string[];
    size(): number;
}
export type IndexedTrackedInstanceRegistry<T extends object> = TrackedInstanceRegistry<T> & Record<string, T | undefined>;
