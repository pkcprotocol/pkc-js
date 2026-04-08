import type { createHelia } from "helia";
import type { HeliaWithKuboRpcClientFunctions, HeliaWithLibp2pPubsub } from "./types.js";
import type { unixfs } from "@helia/unixfs";
import type { ipns } from "@helia/ipns";
import type { ParsedPKCOptions } from "../types.js";
type Libp2pJsClientInit = {
    helia: HeliaWithLibp2pPubsub;
    heliaUnixfs: ReturnType<typeof unixfs>;
    heliaIpnsRouter: ReturnType<typeof ipns>;
    heliaWithKuboRpcClientFunctions: HeliaWithKuboRpcClientFunctions;
    libp2pJsClientsOptions: NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number];
    mergedHeliaOptions: Parameters<typeof createHelia>[0];
    key: string;
    countOfUsesOfInstance: number;
};
export declare class Libp2pJsClient {
    _helia: HeliaWithLibp2pPubsub;
    _heliaUnixfs: ReturnType<typeof unixfs>;
    _heliaIpnsRouter: ReturnType<typeof ipns>;
    heliaWithKuboRpcClientFunctions: HeliaWithKuboRpcClientFunctions;
    _libp2pJsClientsOptions: NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number];
    _mergedHeliaOptions: Parameters<typeof createHelia>[0];
    key: Libp2pJsClientInit["key"];
    countOfUsesOfInstance: number;
    constructor(libp2pJsClientOptions: Libp2pJsClientInit);
}
export {};
