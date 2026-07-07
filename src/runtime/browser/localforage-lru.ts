import localForage from "localforage";
import { omit } from "remeda";

type ForageOptions = {
    size: number;
    name: string;
};

function createLocalForageInstance(localForageLruOptions: ForageOptions) {
    if (typeof localForageLruOptions?.size !== "number") {
        throw Error(`LocalForageLru.createInstance localForageLruOptions.size '${localForageLruOptions?.size}' not a number`);
    }
    const localForageOptions = omit(localForageLruOptions, ["size"]);
    let database1: LocalForage,
        database2: LocalForage,
        databaseSize: number,
        initialized = false;

    const initializationPromize = new Promise(async (resolve) => {
        const localForage1 = localForage.createInstance({
            ...localForageOptions,
            name: localForageLruOptions.name
        });
        const localForage2 = localForage.createInstance({
            ...localForageOptions,
            name: localForageLruOptions.name + "2"
        });
        const [localForage1Size, localForage2Size] = await Promise.all([localForage1.length(), localForage2.length()]);
        // largest db is always active db, unless is max size, because max sized db is always inactive
        if (
            (localForage1Size >= localForage2Size && localForage1Size !== localForageLruOptions.size) ||
            localForage2Size === localForageLruOptions.size
        ) {
            database2 = localForage2;
            database1 = localForage1;
            databaseSize = localForage1Size;
        } else {
            database2 = localForage1;
            database1 = localForage2;
            databaseSize = localForage2Size;
        }
        initialized = true;
        resolve(undefined);
    });

    return {
        getItem: async function (key: string): Promise<any> {
            await initialization();
            const [value, value2] = await Promise.all([database1.getItem(key), database2.getItem(key)]);

            let returnValue = value;
            if (returnValue !== null && returnValue !== undefined) return returnValue;
            if ((returnValue = value2) !== null && (returnValue = value2) !== undefined) {
                await updateDatabases(key, returnValue);
                return returnValue;
            }
        },
        setItem: async function (key: string, value: any) {
            await initialization();
            const databaseValue = await database1.getItem(key);
            if (databaseValue !== null && databaseValue !== undefined) {
                try {
                    await database1.setItem(key, value);
                } catch (error: any) {
                    console.error("localforageLru.setItem setItem error", { error, errorMessage: error?.message, key, value });
                    throw error;
                }
            } else {
                await updateDatabases(key, value);
            }
        },
        removeItem: async function (key: string) {
            await initialization();
            await Promise.all([database1.removeItem(key), database2.removeItem(key)]);
        },
        clear: async function () {
            await initialization();
            await Promise.all([database1.clear(), database2.clear()]);
        },
        key: async function (keyIndex: number) {
            throw Error("not implemented");
        },
        // don't use for init react state, use entries() instead
        keys: async function () {
            await initialization();
            const [keys1, keys2] = await Promise.all([database1.keys(), database2.keys()]);
            return Array.from(new Set([...keys1, ...keys2]));
        },
        // useful to init a react state on load
        entries: async function () {
            await initialization();
            const [keys1, keys2] = await Promise.all([database1.keys(), database2.keys()]);
            const keys = Array.from(new Set([...keys1, ...keys2]));
            const entries: any[] = [];
            const getItem = async (key: string) => {
                const [value, value2] = await Promise.all([database1.getItem(key), database2.getItem(key)]);
                if (value !== null && value !== undefined) {
                    return value;
                }
                return value2;
            };
            await Promise.all(
                keys.map((key, i) =>
                    getItem(key).then((value) => {
                        entries[i] = [key, value];
                    })
                )
            );
            return entries;
        },
        length: async function () {
            throw Error("not implemented");
        }
    };

    async function updateDatabases(key: string, value: any) {
        try {
            await database1.setItem(key, value);
        } catch (error: any) {
            console.error("localforageLru updateDatabases setItem error", { error, errorMessage: error?.message, key, value });

            // ignore this error, don't know why it happens
            if (error?.message?.includes?.("unit storage quota has been exceeded")) {
                return;
            }
            throw error;
        }
        databaseSize++;
        if (databaseSize >= localForageLruOptions.size) {
            databaseSize = 0;
            const database1Temp = database1;
            const database2Temp = database2;
            database2 = database1Temp;
            database1 = database2Temp;
            await database1.clear();
        }
    }

    async function initialization() {
        if (initialized) {
            return;
        }
        return initializationPromize;
    }
}

const instances: Record<string, ReturnType<typeof createLocalForageInstance>> = {};

export const createInstance = (localForageLruOptions: ForageOptions) => {
    if (typeof localForageLruOptions?.name !== "string") {
        throw Error(`LocalForageLru.createInstance localForageLruOptions.name '${localForageLruOptions?.name}' not a string`);
    }
    if (instances[localForageLruOptions.name]) return instances[localForageLruOptions.name];

    instances[localForageLruOptions.name] = createLocalForageInstance(localForageLruOptions);
    return instances[localForageLruOptions.name];
};
