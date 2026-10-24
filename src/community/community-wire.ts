import { isEmpty, omit } from "remeda";
import type { CommunityIpfsType } from "./types.js";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import { areEquivalentCommunityAddresses, isStringDomain } from "../util.js";
import { PKCError } from "../pkc-error.js";

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
    return omit(community, runtimeOnlyCommunityFields) as Partial<CommunityIpfsType> & Record<string, unknown>;
}

export function cleanWireCommunity(community?: LooseCommunityIpfs): Partial<CommunityIpfsType> | undefined {
    const wireCommunity = omitRuntimeCommunityFields(community);
    if (isEmpty(wireCommunity)) return undefined;
    return wireCommunity as Partial<CommunityIpfsType>;
}

export function getCommunityNameFromWire(community?: LooseCommunityIpfs): string | undefined {
    const wireCommunity = omitRuntimeCommunityFields(community);
    if (typeof wireCommunity.name === "string") return wireCommunity.name;
    // Backward compat: old records have address as a domain name
    if (typeof community?.address === "string" && isStringDomain(community.address)) return community.address;
    return undefined;
}

// A loader that asked for a community by name accepts only records that claim that name. The signature
// proves which key published a record, not which name the record claims, so a record without the name or
// with a different one is genuine but not the community the caller asked for: the owner dropped or
// renamed the name, or the name was re-pointed. Returns the error to emit, or undefined when the record
// claims the name or nothing was requested by name. Retriable, because a later record can claim the name
// again. See docs/protocol/names-and-addresses.md.
export function findCommunityRecordNameMismatch(opts: {
    requestedName: string | undefined;
    record: CommunityIpfsType;
    communityPublicKey: string | undefined;
}): PKCError | undefined {
    if (!opts.requestedName) return undefined;
    const recordName = getCommunityNameFromWire(opts.record as LooseCommunityIpfs);
    if (recordName && areEquivalentCommunityAddresses(recordName, opts.requestedName)) return undefined;
    return new PKCError("ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME", {
        requestedName: opts.requestedName,
        recordName,
        communityPublicKey: opts.communityPublicKey,
        recordUpdatedAt: opts.record.updatedAt,
        retriableError: true
    });
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
