import { GenericStateClient } from "../generic-state-client.js";
import type { NameResolverClient } from "../clients/name-resolver-client.js";

type SubplebbitGatewayState = "stopped" | "fetching-ipns";

type SubplebbitIpfsState = "stopped" | "fetching-ipns" | "fetching-ipfs" | "publishing-ipns";
type SubplebbitPubsubState =
    | "stopped"
    | "waiting-challenge-requests"
    | "publishing-challenge"
    | "waiting-challenge-answers"
    | "publishing-challenge-verification";

type SubplebbitRpcState =
    | NameResolverClient["state"]
    | SubplebbitIpfsState
    | SubplebbitPubsubState
    | SubplebbitGatewayState
    | "resolving-subplebbit-address";

type SubplebbitLibp2pJsState = SubplebbitIpfsState | SubplebbitPubsubState;

export class SubplebbitKuboPubsubClient extends GenericStateClient<SubplebbitPubsubState> {}

export class SubplebbitKuboRpcClient extends GenericStateClient<SubplebbitIpfsState> {}

export class SubplebbitPlebbitRpcStateClient extends GenericStateClient<SubplebbitRpcState> {}

export class SubplebbitLibp2pJsClient extends GenericStateClient<SubplebbitLibp2pJsState> {}

export class SubplebbitIpfsGatewayClient extends GenericStateClient<SubplebbitGatewayState> {}
