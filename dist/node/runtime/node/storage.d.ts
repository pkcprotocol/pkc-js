import type { StorageInterface } from "../../types.js";
export default class Storage implements StorageInterface {
    private _pkc;
    private _keyv;
    private _db;
    constructor(pkc: Storage["_pkc"]);
    toJSON(): undefined;
    init(): Promise<void>;
    getItem(key: string): Promise<unknown>;
    setItem(key: string, value: any): Promise<void>;
    removeItem(key: string | string[]): Promise<boolean>;
    clear(): Promise<void>;
    destroy(): Promise<void>;
}
