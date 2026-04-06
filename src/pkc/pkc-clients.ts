import { GenericStateClient } from "../generic-state-client.js";

type PKCIpfsGatewayState = "fetching-ipfs" | "stopped";

type PKCKuboRpcState = "fetching-ipfs" | "stopped";

type PKCLibp2pJsState = "fetching-ipfs" | "stopped";

export class PKCIpfsGatewayClient extends GenericStateClient<PKCIpfsGatewayState | string> {}

export class PKCKuboRpcClient extends GenericStateClient<PKCKuboRpcState | string> {}

export class PKCLibp2pJsClient extends GenericStateClient<PKCLibp2pJsState | string> {}
