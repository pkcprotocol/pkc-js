import "./zod-error-map.js";
import polyfill from "./runtime/node/polyfill.js";
polyfill();
import * as PKCClass from "./pkc/pkc.js";
import type { InputPKCOptions } from "./types.js";
import { setNativeFunctions as utilSetNativeFunctions } from "./runtime/node/util.js";
import nodeNativeFunctions from "./runtime/node/native-functions.js";
import browserNativeFunctions from "./runtime/browser/native-functions.js";
import { shortifyAddress, shortifyCid } from "./util.js";
import { createAnchorIpnsRecord as signerCreateAnchorIpnsRecord } from "./signer/ipns-record.js";
import { pkcJsChallenges } from "./runtime/node/community/challenges/index.js";
import { PKCWithRpcClient } from "./pkc/pkc-with-rpc-client.js";
import type { AuthorNameRpcParam, CidRpcParam } from "./clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam } from "./clients/rpc-client/rpc-schema-util.js";

const PKC = async function PKC(pkcOptions: InputPKCOptions = {}): Promise<PKCClass.PKC> {
    const pkc = pkcOptions.pkcRpcClientsOptions ? new PKCWithRpcClient(pkcOptions) : new PKCClass.PKC(pkcOptions);
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
PKC.challenges = pkcJsChallenges;
// Delegation setup (#234): the anchor record An -> Mn is signed with As, the one key that by design
// never reaches the node, so this is the single step of the flow that has to run in the consumer's
// process. Nothing in src/ calls it and nothing ever can, which is exactly why it belongs on the
// public entry: without it the primitive is unreachable, since package.json's exports map has no
// subpath that would let a consumer deep-import src/signer. Browser-safe, same as the browser entry.
PKC.createAnchorIpnsRecord = signerCreateAnchorIpnsRecord;
export default PKC;
export const setNativeFunctions = PKC.setNativeFunctions;
export const nativeFunctions = PKC.nativeFunctions;
export const getShortCid = PKC.getShortCid;
export const getShortAddress = PKC.getShortAddress;
export const challenges = PKC.challenges;
export const createAnchorIpnsRecord = PKC.createAnchorIpnsRecord;

// Public re-exports: name-resolver contract — let third-party resolver
// packages (e.g. @bitsocial/bso-resolver) consume these types directly from
// the root entry instead of deep-importing from "./schema.js".
export type { NameResolverInterface } from "./schema.js";
export type { NameResolver } from "./types.js";

// Public re-exports: shared-Helia-node accessor (issue #221) — let consumers that run on the
// shared node (e.g. @bitsocial/pubsub-voting, bitsocial-seeder) name the accessor's types from
// the root entry instead of reaching through private fields or deep-importing internals.
export type { Libp2pJsClient } from "./helia/libp2pjsClient.js";
export type { HeliaWithLibp2pPubsub } from "./helia/types.js";

// Public re-exports: CommunityList (docs/protocol/community-lists.md)
export type { CommunityList } from "./community-list/community-list.js";
export type {
    CommunityListIpfsType,
    CommunityListEntryType,
    CreateCommunityListOptions,
    CreateNewCommunityListOptions,
    CreateCommunityListWithCidOptions
} from "./community-list/types.js";
