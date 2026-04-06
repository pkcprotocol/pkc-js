import { GenericStateClient } from "../generic-state-client.js";

type PlebbitIpfsGatewayState = "fetching-ipfs" | "stopped";

type PlebbitKuboRpcState = "fetching-ipfs" | "stopped";

type PlebbitLibp2pJsState = "fetching-ipfs" | "stopped";

export class PlebbitIpfsGatewayClient extends GenericStateClient<PlebbitIpfsGatewayState | string> {}

export class PlebbitKuboRpcClient extends GenericStateClient<PlebbitKuboRpcState | string> {}

export class PlebbitLibp2pJsClient extends GenericStateClient<PlebbitLibp2pJsState | string> {}
