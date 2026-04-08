import { GenericStateClient } from "../generic-state-client.js";
import type { NameResolverClient } from "../clients/name-resolver-client.js";
type CommunityGatewayState = "stopped" | "fetching-ipns";
type CommunityIpfsState = "stopped" | "fetching-ipns" | "fetching-ipfs" | "publishing-ipns";
type CommunityPubsubState = "stopped" | "waiting-challenge-requests" | "publishing-challenge" | "waiting-challenge-answers" | "publishing-challenge-verification";
type CommunityRpcState = NameResolverClient["state"] | CommunityIpfsState | CommunityPubsubState | CommunityGatewayState | "resolving-community-name";
type CommunityLibp2pJsState = CommunityIpfsState | CommunityPubsubState;
export declare class CommunityKuboPubsubClient extends GenericStateClient<CommunityPubsubState> {
}
export declare class CommunityKuboRpcClient extends GenericStateClient<CommunityIpfsState> {
}
export declare class CommunityPKCRpcStateClient extends GenericStateClient<CommunityRpcState> {
}
export declare class CommunityLibp2pJsClient extends GenericStateClient<CommunityLibp2pJsState> {
}
export declare class CommunityIpfsGatewayClient extends GenericStateClient<CommunityGatewayState> {
}
export {};
