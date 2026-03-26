import * as remeda from "remeda";
import type { SubplebbitIpfsType } from "./types.js";
import { getPlebbitAddressFromPublicKeySync } from "../signer/util.js";
import { isStringDomain } from "../util.js";

const runtimeOnlySubplebbitFields = ["address", "publicKey", "shortAddress", "nameResolved"] as const;

type LooseSubplebbitIpfs = Partial<SubplebbitIpfsType> & {
    address?: string;
    publicKey?: string;
    nameResolved?: boolean;
    shortAddress?: string;
} & Record<string, unknown>;

export function omitRuntimeSubplebbitFields<Sub extends LooseSubplebbitIpfs | undefined>(
    sub: Sub
): Partial<SubplebbitIpfsType> & Record<string, unknown> {
    if (!sub) return {};
    return remeda.omit(sub, runtimeOnlySubplebbitFields) as Partial<SubplebbitIpfsType> & Record<string, unknown>;
}

export function cleanWireSubplebbit(sub?: LooseSubplebbitIpfs): Partial<SubplebbitIpfsType> | undefined {
    const wireSub = omitRuntimeSubplebbitFields(sub);
    if (remeda.isEmpty(wireSub)) return undefined;
    return wireSub as Partial<SubplebbitIpfsType>;
}

export function getSubplebbitNameFromWire(sub?: LooseSubplebbitIpfs): string | undefined {
    const wireSub = omitRuntimeSubplebbitFields(sub);
    if (typeof wireSub.name === "string") return wireSub.name;
    // Backward compat: old records have address as a domain name
    if (typeof sub?.address === "string" && isStringDomain(sub.address)) return sub.address;
    return undefined;
}

export function getSubplebbitDomainFromWire(sub?: LooseSubplebbitIpfs): string | undefined {
    const name = getSubplebbitNameFromWire(sub);
    return typeof name === "string" && isStringDomain(name) ? name : undefined;
}

export function buildRuntimeSubplebbit({
    subplebbitRecord,
    signaturePublicKey
}: {
    subplebbitRecord?: LooseSubplebbitIpfs;
    signaturePublicKey: string;
}): { address: string; publicKey: string; name?: string } {
    const publicKey = getPlebbitAddressFromPublicKeySync(signaturePublicKey);
    const name = getSubplebbitNameFromWire(subplebbitRecord);
    return {
        ...(name ? { name } : undefined),
        address: name || publicKey,
        publicKey
    };
}
