import type { createHelia } from "helia";
import type { HeliaWithKuboRpcClientFunctions, HeliaWithLibp2pPubsub } from "./types.js";
import type { unixfs } from "@helia/unixfs";
import { hideClassPrivateProps } from "../util.js";
import type { ipns } from "@helia/ipns";
import type { ParsedPKCOptions } from "../types.js";

type Libp2pJsClientInit = {
    helia: HeliaWithLibp2pPubsub;
    heliaUnixfs: ReturnType<typeof unixfs>;
    heliaIpnsRouter: ReturnType<typeof ipns>;
    heliaWithKuboRpcClientFunctions: HeliaWithKuboRpcClientFunctions;
    libp2pJsClientsOptions: NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number];
    mergedHeliaOptions: Parameters<typeof createHelia>[0]; // merged defaults with user input for helia and libp2p
    key: string;
    countOfUsesOfInstance: number;
};

export class Libp2pJsClient {
    _helia: HeliaWithLibp2pPubsub;
    _heliaUnixfs: ReturnType<typeof unixfs>;
    _heliaIpnsRouter: ReturnType<typeof ipns>;
    heliaWithKuboRpcClientFunctions: HeliaWithKuboRpcClientFunctions;
    _libp2pJsClientsOptions: NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number];
    _mergedHeliaOptions: Omit<NonNullable<Parameters<typeof createHelia>[0]>, "http"> | undefined; // merged defaults with user input for helia and libp2p
    key: Libp2pJsClientInit["key"];
    countOfUsesOfInstance: number;

    /**
     * The running Helia node backing this libp2p-js client — the public, semver-covered way for
     * consumers that share the node (e.g. @bitsocial/pubsub-voting, bitsocial-seeder) to reach it,
     * instead of the private `_helia` field (issue #221).
     *
     * The returned node is guaranteed to carry, in addition to Helia's own surface:
     * - `libp2p.services.pubsub` — the gossipsub service registered at node construction
     * - `libp2p.services.fetch` — the `@libp2p/fetch` service registered at node construction
     * - `blockstore` — the node's block storage (bitswap-backed retrieval)
     * - `libp2p.contentRouting` — the delegated-routing aggregation over `httpRoutersOptions`
     *
     * A breaking change to what this accessor returns is a breaking pkc-js release.
     */
    get heliaNode(): HeliaWithLibp2pPubsub {
        return this._helia;
    }

    constructor(libp2pJsClientOptions: Libp2pJsClientInit) {
        this._helia = libp2pJsClientOptions.helia;
        this._heliaUnixfs = libp2pJsClientOptions.heliaUnixfs;
        this._heliaIpnsRouter = libp2pJsClientOptions.heliaIpnsRouter;
        this.heliaWithKuboRpcClientFunctions = libp2pJsClientOptions.heliaWithKuboRpcClientFunctions;
        this._libp2pJsClientsOptions = libp2pJsClientOptions.libp2pJsClientsOptions;
        this._mergedHeliaOptions = libp2pJsClientOptions.mergedHeliaOptions;
        this.key = libp2pJsClientOptions.key;
        this.countOfUsesOfInstance = libp2pJsClientOptions.countOfUsesOfInstance;

        hideClassPrivateProps(this);
    }
}
