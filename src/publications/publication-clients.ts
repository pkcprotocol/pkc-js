import { GenericStateClient } from "../generic-state-client.js";
import { CommentIpfsState, CommentLibp2pJsClient } from "./comment/comment-clients.js";
import type { NameResolverClient } from "../clients/name-resolver-client.js";

type PublicationGatewayState = "stopped" | "fetching-subplebbit-ipns";

type PublicationIpfsState = "stopped" | "fetching-subplebbit-ipns" | "fetching-subplebbit-ipfs";

type PublicationPubsubState =
    | "stopped"
    | "publishing-challenge-request"
    | "subscribing-pubsub"
    | "waiting-challenge"
    | "waiting-challenge-answers"
    | "publishing-challenge-answer"
    | "waiting-challenge-verification";

type PublicationLibp2pJsState = PublicationIpfsState | PublicationPubsubState | CommentIpfsState;

type PublicationRpcState = NameResolverClient["state"] | PublicationLibp2pJsState | "resolving-community-name" | "resolving-author-name";

export class PublicationLibp2pJsClient extends GenericStateClient<PublicationLibp2pJsState> {}

export class PublicationKuboRpcClient extends GenericStateClient<PublicationIpfsState> {}

export class PublicationKuboPubsubClient extends GenericStateClient<PublicationPubsubState> {}

export class PublicationIpfsGatewayClient extends GenericStateClient<PublicationGatewayState> {}

export class PublicationPKCRpcStateClient extends GenericStateClient<PublicationRpcState> {}
