import type { CommunityIpfsType } from "./types.js";
type LooseCommunityIpfs = Partial<CommunityIpfsType> & {
    address?: string;
    publicKey?: string;
    nameResolved?: boolean;
    shortAddress?: string;
} & Record<string, unknown>;
export declare function omitRuntimeCommunityFields<Community extends LooseCommunityIpfs | undefined>(community: Community): Partial<CommunityIpfsType> & Record<string, unknown>;
export declare function cleanWireCommunity(community?: LooseCommunityIpfs): Partial<CommunityIpfsType> | undefined;
export declare function getCommunityNameFromWire(community?: LooseCommunityIpfs): string | undefined;
export declare function getCommunityDomainFromWire(community?: LooseCommunityIpfs): string | undefined;
export declare function buildRuntimeCommunity({ communityRecord, signaturePublicKey }: {
    communityRecord?: LooseCommunityIpfs;
    signaturePublicKey: string;
}): {
    address: string;
    publicKey: string;
    name?: string;
};
export {};
