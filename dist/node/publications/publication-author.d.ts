import type { AuthorPubsubType, RuntimeAuthorType, RuntimeAuthorWithCommentUpdateType } from "../types.js";
type LooseAuthor = Partial<RuntimeAuthorWithCommentUpdateType> & Record<string, unknown>;
export declare function omitRuntimeAuthorFields<Author extends LooseAuthor | undefined>(author: Author): Partial<AuthorPubsubType> & Record<string, unknown>;
export declare function cleanWireAuthor(author?: LooseAuthor): AuthorPubsubType | undefined;
export declare function normalizeCreatePublicationAuthor(author?: LooseAuthor): LooseAuthor | undefined;
export declare function getAuthorNameFromWire(author?: LooseAuthor): string | undefined;
export declare function getAuthorDomainFromWire(author?: LooseAuthor): string | undefined;
export declare function getAuthorDomainFromRuntime(author?: Pick<RuntimeAuthorType, "name" | "address"> | undefined): string | undefined;
export declare function buildRuntimeAuthor({ author, signaturePublicKey, community }: {
    author?: LooseAuthor;
    signaturePublicKey: string;
    community?: RuntimeAuthorWithCommentUpdateType["community"];
}): RuntimeAuthorWithCommentUpdateType;
export declare function buildRuntimeAuthorWithShortAddress({ author, signaturePublicKey, shortAddress, community }: {
    author?: LooseAuthor;
    signaturePublicKey: string;
    shortAddress: string;
    community?: RuntimeAuthorWithCommentUpdateType["community"];
}): RuntimeAuthorWithCommentUpdateType & {
    shortAddress: string;
};
export {};
