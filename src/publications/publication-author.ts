import * as remeda from "remeda";
import type { AuthorPubsubType, RuntimeAuthorType, RuntimeAuthorWithCommentUpdateType } from "../types.js";
import { getPlebbitAddressFromPublicKeySync } from "../signer/util.js";
import { isStringDomain } from "../util.js";

const runtimeOnlyAuthorFields = ["address", "publicKey", "shortAddress", "subplebbit"] as const;

type LooseAuthor = Partial<RuntimeAuthorWithCommentUpdateType> & Record<string, unknown>;

export function omitRuntimeAuthorFields<Author extends LooseAuthor | undefined>(
    author: Author
): Partial<AuthorPubsubType> & Record<string, unknown> {
    if (!author) return {};
    return remeda.omit(author, runtimeOnlyAuthorFields) as Partial<AuthorPubsubType> & Record<string, unknown>;
}

export function cleanWireAuthor(author?: LooseAuthor): AuthorPubsubType | undefined {
    const wireAuthor = omitRuntimeAuthorFields(author);
    if (remeda.isEmpty(wireAuthor)) return undefined;
    return wireAuthor as AuthorPubsubType;
}

export function getAuthorNameFromWire(author?: LooseAuthor): string | undefined {
    const wireAuthor = omitRuntimeAuthorFields(author);
    if (typeof wireAuthor.name === "string") return wireAuthor.name;
    if (typeof author?.address === "string" && isStringDomain(author.address)) return author.address;
    return undefined;
}

export function getAuthorDomainFromWire(author?: LooseAuthor): string | undefined {
    const name = getAuthorNameFromWire(author);
    return typeof name === "string" && isStringDomain(name) ? name : undefined;
}

export function getAuthorDomainFromRuntime(author?: Pick<RuntimeAuthorType, "name" | "address"> | undefined): string | undefined {
    if (typeof author?.name === "string" && isStringDomain(author.name)) return author.name;
    if (typeof author?.address === "string" && isStringDomain(author.address)) return author.address;
    return undefined;
}

export function buildRuntimeAuthor({
    author,
    signaturePublicKey,
    subplebbit
}: {
    author?: LooseAuthor;
    signaturePublicKey: string;
    subplebbit?: RuntimeAuthorWithCommentUpdateType["subplebbit"];
}): RuntimeAuthorWithCommentUpdateType {
    const publicKey = getPlebbitAddressFromPublicKeySync(signaturePublicKey);
    const name = getAuthorNameFromWire(author);
    const wireAuthor = cleanWireAuthor(author) || {};
    const runtimeAuthor: RuntimeAuthorWithCommentUpdateType = {
        ...wireAuthor,
        ...(name ? { name } : undefined),
        ...(subplebbit ? { subplebbit } : undefined),
        address: name || publicKey,
        publicKey
    };
    return runtimeAuthor;
}

export function buildRuntimeAuthorWithShortAddress({
    author,
    signaturePublicKey,
    shortAddress,
    subplebbit
}: {
    author?: LooseAuthor;
    signaturePublicKey: string;
    shortAddress: string;
    subplebbit?: RuntimeAuthorWithCommentUpdateType["subplebbit"];
}): RuntimeAuthorWithCommentUpdateType & { shortAddress: string } {
    return {
        ...buildRuntimeAuthor({ author, signaturePublicKey, subplebbit }),
        shortAddress
    };
}
