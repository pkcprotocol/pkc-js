import "./zod-error-map.js";
import polyfill from "./runtime/node/polyfill.js";
polyfill();
import * as PKCClass from "./pkc/pkc.js";
import { setNativeFunctions as utilSetNativeFunctions } from "./runtime/node/util.js";
import nodeNativeFunctions from "./runtime/node/native-functions.js";
import browserNativeFunctions from "./runtime/browser/native-functions.js";
import { shortifyAddress, shortifyCid } from "./util.js";
import { pkcJsChallenges } from "./runtime/node/community/challenges/index.js";
import { PKCWithRpcClient } from "./pkc/pkc-with-rpc-client.js";
import { parseRpcAuthorNameParam, parseRpcCidParam } from "./clients/rpc-client/rpc-schema-util.js";
const PKC = async function PKC(pkcOptions = {}) {
    const pkc = pkcOptions.pkcRpcClientsOptions ? new PKCWithRpcClient(pkcOptions) : new PKCClass.PKC(pkcOptions);
    await pkc._init();
    return pkc;
};
const getShortAddressValue = (params) => {
    const parsed = parseRpcAuthorNameParam(params);
    return shortifyAddress(parsed.address);
};
const getShortCidValue = (params) => {
    const parsed = parseRpcCidParam(params);
    return shortifyCid(parsed.cid);
};
PKC.setNativeFunctions = utilSetNativeFunctions;
PKC.nativeFunctions = { node: nodeNativeFunctions, browser: browserNativeFunctions };
PKC.getShortCid = getShortCidValue;
PKC.getShortAddress = getShortAddressValue;
PKC.challenges = pkcJsChallenges;
export default PKC;
export const setNativeFunctions = PKC.setNativeFunctions;
export const nativeFunctions = PKC.nativeFunctions;
export const getShortCid = PKC.getShortCid;
export const getShortAddress = PKC.getShortAddress;
export const challenges = PKC.challenges;
//# sourceMappingURL=index.js.map