import { firstBy, keys } from "remeda";
import { timestamp } from "../util.js";
import type { CommunityIpfsType, CommunityJson } from "./types.js";
import type { PKCError } from "../pkc-error.js";

// Resolution of a single gateway fetch: either the raw response + body text, or a captured error.
// Mirrors what base-client-manager's _fetchWithGateway resolves to.
export type GatewayFetchResult = { res: Response; resText: string | undefined } | { error: PKCError };

// Standalone (no dependency on the client-manager class graph) so the pure selection logic below
// can be imported and unit-tested without pulling in the circular client-manager imports.
export type CommunityGatewayFetch = {
    [gatewayUrl: string]: {
        abortController: AbortController;
        promise: Promise<GatewayFetchResult>;
        cid?: CommunityJson["updateCid"];
        communityRecord?: CommunityIpfsType;
        error?: PKCError;
        timeoutId: ReturnType<typeof setTimeout>;
        ttl?: number; // ttl in seconds of IPNS record
        ipnsHops?: string[]; // the resolved IPNS chain [anchor, ..., terminal] for THIS gateway's record
    };
};

// Selects the most recent community record across the gateway responses, returning the winner
// together with ITS OWN resolved ipnsHops. Pure (no `this`) so the winner/hops binding can be
// unit-tested directly — gateways race and can resolve different chains, so the hops must come
// from the gateway whose record we actually keep, not whichever callback wrote last.
export function selectWinningGatewayCommunity(opts: {
    gatewayFetches: CommunityGatewayFetch;
    currentUpdatedAt: number;
    totalGateways: number;
    fallbackIpnsName: string;
}): { community: CommunityIpfsType; cid: string; ipnsHops: string[]; bestGatewayUrl: string; recordAgeSeconds: number } | undefined {
    const { gatewayFetches, currentUpdatedAt, totalGateways, fallbackIpnsName } = opts;
    const gatewaysWithCommunity = keys(gatewayFetches).filter((gatewayUrl) => gatewayFetches[gatewayUrl].communityRecord);
    if (gatewaysWithCommunity.length === 0) return undefined;

    const gatewaysWithError = keys(gatewayFetches).filter((gatewayUrl) => gatewayFetches[gatewayUrl].error);
    const bestGatewayUrl = <string>(
        firstBy(gatewaysWithCommunity, [(gatewayUrl) => gatewayFetches[gatewayUrl].communityRecord!.updatedAt, "desc"])
    );
    const best = gatewayFetches[bestGatewayUrl];

    if (best.communityRecord!.updatedAt > currentUpdatedAt)
        return {
            community: best.communityRecord!,
            cid: best.cid!,
            ipnsHops: best.ipnsHops ?? [fallbackIpnsName],
            bestGatewayUrl,
            recordAgeSeconds: timestamp() - best.communityRecord!.updatedAt
        };

    // We weren't able to find any new community records
    if (gatewaysWithError.length + gatewaysWithCommunity.length === totalGateways) return undefined;
    return undefined;
}
