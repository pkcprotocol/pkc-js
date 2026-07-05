// Slim RPC-only entry (`"./client"` export). Issue #120 / Lever B: consumers that ONLY talk to a
// remote daemon over RPC (e.g. the bitsocial CLI) never start a local P2P node, yet importing the
// full "." entry drags in the signer (-> @libp2p/peer-id), the pages/comment graph
// (-> typestub-ipfs-only-hash) and the community subtree — hundreds of ms on slow hosts for code the
// RPC path never runs.
//
// This entry constructs PKCWithRpcClient directly and imports only the RPC transport graph. The heavy
// subgraphs (community classes, publications, signer, pages) are dynamic-imported behind the async
// createCommunity / create* / publish boundaries in pkc.ts + pkc-with-rpc-client.ts, so a fresh
// `import("@pkcprotocol/pkc-js/client")` — and read-only commands like `community list` that never
// materialize a community — pay only the transport floor. config/verify-bundle.js asserts those
// subgraphs are NOT in this entry's static closure.
//
// It is a strict subset of the "." entry: same PKC factory shape, but it throws if the caller did not
// pass pkcRpcClientsOptions (there is no local node here to fall back to).
import "./zod-error-map.js";
import polyfill from "./runtime/node/polyfill.js";
polyfill();
import { PKCWithRpcClient } from "./pkc/pkc-with-rpc-client.js";
import type { InputPKCOptions } from "./types.js";
import type { PKC as PKCClass } from "./pkc/pkc.js";
import { setNativeFunctions as utilSetNativeFunctions } from "./runtime/node/util.js";
import nodeNativeFunctions from "./runtime/node/native-functions.js";
import browserNativeFunctions from "./runtime/browser/native-functions.js";
import { shortifyAddress, shortifyCid } from "./util.js";
import type { AuthorNameRpcParam, CidRpcParam } from "./clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam } from "./clients/rpc-client/rpc-schema-util.js";

const PKC = async function PKC(pkcOptions: InputPKCOptions = {}): Promise<PKCClass> {
    if (!pkcOptions.pkcRpcClientsOptions?.length)
        throw new Error(
            '@pkcprotocol/pkc-js/client is an RPC-only entry: pass pkcRpcClientsOptions (e.g. ["ws://localhost:9138"]). ' +
                'For a local IPFS/libp2p or gateway node, import the default "@pkcprotocol/pkc-js" entry instead.'
        );
    const pkc = new PKCWithRpcClient(pkcOptions);
    await pkc._init();
    return pkc;
};

const getShortAddressValue = (params: AuthorNameRpcParam) => {
    const parsed = parseRpcAuthorNameParam(params);
    return shortifyAddress(parsed.name);
};
const getShortCidValue = (params: CidRpcParam) => {
    const parsed = parseRpcCidParam(params);
    return shortifyCid(parsed.cid);
};

PKC.setNativeFunctions = utilSetNativeFunctions;
PKC.nativeFunctions = { node: nodeNativeFunctions, browser: browserNativeFunctions };
PKC.getShortCid = getShortCidValue;
PKC.getShortAddress = getShortAddressValue;
export default PKC;
export const setNativeFunctions = PKC.setNativeFunctions;
export const nativeFunctions = PKC.nativeFunctions;
export const getShortCid = PKC.getShortCid;
export const getShortAddress = PKC.getShortAddress;

// Public type surface — keep identical to the "." entry so `@pkcprotocol/pkc-js/client` is a drop-in
// for RPC-only consumers.
export type { NameResolverInterface } from "./schema.js";
export type { NameResolver } from "./types.js";
