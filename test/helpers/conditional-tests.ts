import { it, describe } from "vitest";
import { isRpcFlagOn } from "../../dist/node/test/test-util.js";

export const describeSkipIfRpc = describe.runIf(!isRpcFlagOn());
export const describeIfRpc = describe.runIf(isRpcFlagOn());
export const itSkipIfRpc = it.runIf(!isRpcFlagOn());
export const itIfRpc = it.runIf(isRpcFlagOn());
