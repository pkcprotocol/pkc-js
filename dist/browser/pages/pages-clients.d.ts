import { GenericStateClient } from "../generic-state-client.js";
type PagesGatewayState = "fetching-ipfs" | "stopped";
export declare class PagesIpfsGatewayClient extends GenericStateClient<PagesGatewayState> {
}
export declare class PagesKuboRpcClient extends GenericStateClient<PagesGatewayState> {
}
export declare class PagesLibp2pJsClient extends GenericStateClient<PagesGatewayState> {
}
export declare class PagesPKCRpcStateClient extends GenericStateClient<PagesGatewayState> {
}
export {};
