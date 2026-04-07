import * as remeda from "remeda";
import type { CommunityIpfsType } from "./types.js";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import { isStringDomain } from "../util.js";

const runtimeOnlyCommunityFields = ["address", "publicKey", "shortAddress", "nameResolved"] as const;

type LooseCommunityIpfs = Partial<CommunityIpfsType> & {
    address?: string;
    publicKey?: string;
    nameResolved?: boolean;
    shortAddress?: string;
} & Record<string, unknown>;

export function omitRuntimeCommunityFields<Community extends LooseCommunityIpfs | undefined>(
    community: Community
): Partial<CommunityIpfsType> & Record<string, unknown> {
    if (!community) return {};
    return remeda.omit(community, runtimeOnlyCommunityFields) as Partial<CommunityIpfsType> & Record<string, unknown>;
}

export function cleanWireCommunity(community?: LooseCommunityIpfs): Partial<CommunityIpfsType> | undefined {
    const wireCommunity = omitRuntimeCommunityFields(community);
    if (remeda.isEmpty(wireCommunity)) return undefined;
    return wireCommunity as Partial<CommunityIpfsType>;
}

export function getCommunityNameFromWire(community?: LooseCommunityIpfs): string | undefined {
    const wireCommunity = omitRuntimeCommunityFields(community);
    if (typeof wireCommunity.name === "string") return wireCommunity.name;
    // Backward compat: old records have address as a domain name
    if (typeof community?.address === "string" && isStringDomain(community.address)) return community.address;
    return undefined;
}

export function getCommunityDomainFromWire(community?: LooseCommunityIpfs): string | undefined {
    const name = getCommunityNameFromWire(community);
    return typeof name === "string" && isStringDomain(name) ? name : undefined;
}

export function buildRuntimeCommunity({
    communityRecord,
    signaturePublicKey
}: {
    communityRecord?: LooseCommunityIpfs;
    signaturePublicKey: string;
}): { address: string; publicKey: string; name?: string } {
    const publicKey = getPKCAddressFromPublicKeySync(signaturePublicKey);
    const name = getCommunityNameFromWire(communityRecord);
    return {
        ...(name ? { name } : undefined),
        address: name || publicKey,
        publicKey
    };
}
