import "./zod-error-map.js";
import polyfill from "./runtime/node/polyfill.js";
polyfill();
import * as PKCClass from "./pkc/pkc.js";
import type { InputPKCOptions } from "./types.js";
import { setNativeFunctions as utilSetNativeFunctions } from "./runtime/node/util.js";
import nodeNativeFunctions from "./runtime/node/native-functions.js";
import browserNativeFunctions from "./runtime/browser/native-functions.js";
import { shortifyAddress, shortifyCid } from "./util.js";
import { plebbitJsChallenges } from "./runtime/node/community/challenges/index.js";
import { PKCWithRpcClient } from "./pkc/pkc-with-rpc-client.js";
import type { AuthorNameRpcParam, CidRpcParam } from "./clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam } from "./clients/rpc-client/rpc-schema-util.js";

const PKC = async function PKC(plebbitOptions: InputPKCOptions = {}): Promise<PKCClass.PKC> {
    const plebbit = plebbitOptions.pkcRpcClientsOptions ? new PKCWithRpcClient(plebbitOptions) : new PKCClass.PKC(plebbitOptions);
    await plebbit._init();
    return plebbit;
};

const getShortAddressValue = (params: AuthorNameRpcParam) => {
    const parsed = parseRpcAuthorNameParam(params);
    return shortifyAddress(parsed.address);
};
const getShortCidValue = (params: CidRpcParam) => {
    const parsed = parseRpcCidParam(params);
    return shortifyCid(parsed.cid);
};

PKC.setNativeFunctions = utilSetNativeFunctions;
PKC.nativeFunctions = { node: nodeNativeFunctions, browser: browserNativeFunctions };
PKC.getShortCid = getShortCidValue;
PKC.getShortAddress = getShortAddressValue;
PKC.challenges = plebbitJsChallenges;
export default PKC;
export const setNativeFunctions = PKC.setNativeFunctions;
export const nativeFunctions = PKC.nativeFunctions;
export const getShortCid = PKC.getShortCid;
export const getShortAddress = PKC.getShortAddress;
export const challenges = PKC.challenges;
