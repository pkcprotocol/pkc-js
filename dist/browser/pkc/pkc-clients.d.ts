import { GenericStateClient } from "../generic-state-client.js";
type PKCIpfsGatewayState = "fetching-ipfs" | "stopped";
type PKCKuboRpcState = "fetching-ipfs" | "stopped";
type PKCLibp2pJsState = "fetching-ipfs" | "stopped";
export declare class PKCIpfsGatewayClient extends GenericStateClient<PKCIpfsGatewayState | string> {
}
export declare class PKCKuboRpcClient extends GenericStateClient<PKCKuboRpcState | string> {
}
export declare class PKCLibp2pJsClient extends GenericStateClient<PKCLibp2pJsState | string> {
}
export {};
