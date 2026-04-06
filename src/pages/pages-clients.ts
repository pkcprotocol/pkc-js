import { GenericStateClient } from "../generic-state-client.js";

type PagesGatewayState = "fetching-ipfs" | "stopped";

export class PagesIpfsGatewayClient extends GenericStateClient<PagesGatewayState> {}

export class PagesKuboRpcClient extends GenericStateClient<PagesGatewayState> {}

export class PagesLibp2pJsClient extends GenericStateClient<PagesGatewayState> {}

export class PagesPKCRpcStateClient extends GenericStateClient<PagesGatewayState> {}
