import * as remeda from "remeda";
import type { AuthorPubsubType, RuntimeAuthorType, RuntimeAuthorWithCommentUpdateType } from "../types.js";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import { isStringDomain } from "../util.js";

const runtimeOnlyAuthorFields = ["address", "publicKey", "shortAddress", "community", "nameResolved"] as const;

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

export function normalizeCreatePublicationAuthor(author?: LooseAuthor): LooseAuthor | undefined {
    if (!author) return undefined;
    if (typeof author.name === "string") return author;
    if (!isStringDomain(author.address)) return author;

    return {
        ...author,
        name: author.address
    };
}

export function getAuthorNameFromWire(author?: LooseAuthor): string | undefined {
    const wireAuthor = omitRuntimeAuthorFields(author);
    if (typeof wireAuthor.name === "string") return wireAuthor.name;
    if (typeof author?.address === "string" && isStringDomain(author.address)) return author.address;
    return undefined;
}

export function getAuthorNameFromRuntime(author?: Pick<RuntimeAuthorType, "name" | "address"> | undefined): string | undefined {
    if (typeof author?.name === "string") return author.name;
    if (typeof author?.address === "string" && isStringDomain(author.address)) return author.address;
    return undefined;
}

export function buildRuntimeAuthor({
    author,
    signaturePublicKey,
    community
}: {
    author?: LooseAuthor;
    signaturePublicKey: string;
    community?: RuntimeAuthorWithCommentUpdateType["community"];
}): RuntimeAuthorWithCommentUpdateType {
    const publicKey = getPKCAddressFromPublicKeySync(signaturePublicKey);
    const name = getAuthorNameFromWire(author);
    const wireAuthor = cleanWireAuthor(author) || {};
    const runtimeAuthor: RuntimeAuthorWithCommentUpdateType = {
        ...wireAuthor,
        ...(name ? { name } : undefined),
        ...(community ? { community } : undefined),
        address: name || publicKey,
        publicKey
    };
    return runtimeAuthor;
}

export function buildRuntimeAuthorWithShortAddress({
    author,
    signaturePublicKey,
    shortAddress,
    community
}: {
    author?: LooseAuthor;
    signaturePublicKey: string;
    shortAddress: string;
    community?: RuntimeAuthorWithCommentUpdateType["community"];
}): RuntimeAuthorWithCommentUpdateType & { shortAddress: string } {
    return {
        ...buildRuntimeAuthor({ author, signaturePublicKey, community }),
        shortAddress
    };
}
