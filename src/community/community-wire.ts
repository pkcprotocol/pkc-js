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

export function omitRuntimeCommunityFields<Sub extends LooseCommunityIpfs | undefined>(
    sub: Sub
): Partial<CommunityIpfsType> & Record<string, unknown> {
    if (!sub) return {};
    return remeda.omit(sub, runtimeOnlyCommunityFields) as Partial<CommunityIpfsType> & Record<string, unknown>;
}

export function cleanWireCommunity(sub?: LooseCommunityIpfs): Partial<CommunityIpfsType> | undefined {
    const wireSub = omitRuntimeCommunityFields(sub);
    if (remeda.isEmpty(wireSub)) return undefined;
    return wireSub as Partial<CommunityIpfsType>;
}

export function getCommunityNameFromWire(sub?: LooseCommunityIpfs): string | undefined {
    const wireSub = omitRuntimeCommunityFields(sub);
    if (typeof wireSub.name === "string") return wireSub.name;
    // Backward compat: old records have address as a domain name
    if (typeof sub?.address === "string" && isStringDomain(sub.address)) return sub.address;
    return undefined;
}

export function getCommunityDomainFromWire(sub?: LooseCommunityIpfs): string | undefined {
    const name = getCommunityNameFromWire(sub);
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
