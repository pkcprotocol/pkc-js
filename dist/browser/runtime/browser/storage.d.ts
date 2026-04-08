import { StorageInterface } from "../../types.js";
export default class Storage implements StorageInterface {
    private _pkc;
    private _store;
    constructor(pkc: Storage["_pkc"]);
    toJSON(): undefined;
    init(): Promise<void>;
    getItem(key: string): Promise<any>;
    setItem(key: string, value: any): Promise<void>;
    removeItem(key: string | string[]): Promise<boolean>;
    clear(): Promise<void>;
    destroy(): Promise<void>;
}
