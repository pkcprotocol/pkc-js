import { GenericStateClient } from "../generic-state-client.js";
import { CommentIpfsState } from "./comment/comment-clients.js";
import type { NameResolverClient } from "../clients/name-resolver-client.js";
type PublicationGatewayState = "stopped" | "fetching-community-ipns";
type PublicationIpfsState = "stopped" | "fetching-community-ipns" | "fetching-community-ipfs";
type PublicationPubsubState = "stopped" | "publishing-challenge-request" | "subscribing-pubsub" | "waiting-challenge" | "waiting-challenge-answers" | "publishing-challenge-answer" | "waiting-challenge-verification";
type PublicationLibp2pJsState = PublicationIpfsState | PublicationPubsubState | CommentIpfsState;
type PublicationRpcState = NameResolverClient["state"] | PublicationLibp2pJsState | "resolving-community-name" | "resolving-author-name";
export declare class PublicationLibp2pJsClient extends GenericStateClient<PublicationLibp2pJsState> {
}
export declare class PublicationKuboRpcClient extends GenericStateClient<PublicationIpfsState> {
}
export declare class PublicationKuboPubsubClient extends GenericStateClient<PublicationPubsubState> {
}
export declare class PublicationIpfsGatewayClient extends GenericStateClient<PublicationGatewayState> {
}
export declare class PublicationPKCRpcStateClient extends GenericStateClient<PublicationRpcState> {
}
export {};
