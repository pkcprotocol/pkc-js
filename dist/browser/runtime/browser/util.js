import { default as browserNativeFunctions } from "./native-functions.js";
import Logger from "../../logger.js";
import { create as CreateKuboRpcClient } from "kubo-rpc-client";
import { PKCError } from "../../pkc-error.js";
// Functions should not be called in browser
export const getDefaultDataPath = () => undefined;
export const mkdir = () => {
    throw Error("mkdir should not be called in browser");
};
export const listCommunities = () => {
    throw Error("listCommunities should not be called in browser");
};
export const listCommunitiesSync = () => {
    throw Error("listCommunitiesSync should not be called in browser");
};
export const monitorCommunitiesDirectory = () => {
    throw Error("monitorCommunitiesDirectory should not be called in browser");
};
export const tryToDeleteCommunitiesThatFailedToBeDeletedBefore = () => {
    throw Error("tryToDeleteCommunitiesThatFailedToBeDeletedBefore should not be called in browser");
};
export async function importSignerIntoKuboNode(ipnsKeyName, ipfsKey, ipfsNode) {
    const data = new FormData();
    if (typeof ipnsKeyName !== "string")
        throw Error("ipnsKeyName needs to be defined before importing key into IPFS node");
    if (!ipfsKey || ipfsKey.constructor?.name !== "Uint8Array" || ipfsKey.byteLength <= 0)
        throw Error("ipfsKey needs to be defined before importing key into IPFS node");
    // create a fresh ArrayBuffer-backed view to avoid SharedArrayBuffer issues
    const normalizedKey = Uint8Array.from(ipfsKey);
    data.append("file", new Blob([normalizedKey.buffer]));
    const nodeUrl = ipfsNode.url;
    if (!nodeUrl)
        throw Error(`Can't figure out ipfs node URL from ipfsNode (${JSON.stringify(ipfsNode)}`);
    const url = `${nodeUrl}/key/import?arg=${ipnsKeyName}&ipns-base=b58mh`;
    const res = await fetch(url, {
        method: "POST",
        body: data,
        headers: ipfsNode.headers
    });
    if (res.status !== 200)
        throw new PKCError("ERR_FAILED_TO_IMPORT_IPFS_KEY", { url, status: res.status, statusText: res.statusText, ipnsKeyName });
    const resJson = (await res.json());
    return { id: resJson.Id, name: resJson.Name };
}
export function createKuboRpcClient(kuboRpcClientOptions) {
    const log = Logger("pkc-js:pkc:createKuboRpcClient");
    log("Creating a new ipfs client on browser with options", kuboRpcClientOptions);
    const kuboRpcClient = CreateKuboRpcClient({
        ...kuboRpcClientOptions
    });
    return kuboRpcClient;
}
export const nativeFunctions = browserNativeFunctions;
export const setNativeFunctions = (newNativeFunctions) => {
    if (!newNativeFunctions)
        throw Error(`User passed an undefined object to setNativeFunctions`);
    //@ts-expect-error
    for (const i in newNativeFunctions)
        nativeFunctions[i] = newNativeFunctions[i];
};
//# sourceMappingURL=util.js.map