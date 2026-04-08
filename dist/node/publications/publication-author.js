import * as remeda from "remeda";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import { isStringDomain } from "../util.js";
const runtimeOnlyAuthorFields = ["address", "publicKey", "shortAddress", "community", "nameResolved"];
export function omitRuntimeAuthorFields(author) {
    if (!author)
        return {};
    return remeda.omit(author, runtimeOnlyAuthorFields);
}
export function cleanWireAuthor(author) {
    const wireAuthor = omitRuntimeAuthorFields(author);
    if (remeda.isEmpty(wireAuthor))
        return undefined;
    return wireAuthor;
}
export function normalizeCreatePublicationAuthor(author) {
    if (!author)
        return undefined;
    if (typeof author.name === "string")
        return author;
    if (!isStringDomain(author.address))
        return author;
    return {
        ...author,
        name: author.address
    };
}
export function getAuthorNameFromWire(author) {
    const wireAuthor = omitRuntimeAuthorFields(author);
    if (typeof wireAuthor.name === "string")
        return wireAuthor.name;
    if (typeof author?.address === "string" && isStringDomain(author.address))
        return author.address;
    return undefined;
}
export function getAuthorDomainFromWire(author) {
    const name = getAuthorNameFromWire(author);
    return typeof name === "string" && isStringDomain(name) ? name : undefined;
}
export function getAuthorDomainFromRuntime(author) {
    if (typeof author?.name === "string" && isStringDomain(author.name))
        return author.name;
    if (typeof author?.address === "string" && isStringDomain(author.address))
        return author.address;
    return undefined;
}
export function buildRuntimeAuthor({ author, signaturePublicKey, community }) {
    const publicKey = getPKCAddressFromPublicKeySync(signaturePublicKey);
    const name = getAuthorNameFromWire(author);
    const wireAuthor = cleanWireAuthor(author) || {};
    const runtimeAuthor = {
        ...wireAuthor,
        ...(name ? { name } : undefined),
        ...(community ? { community } : undefined),
        address: name || publicKey,
        publicKey
    };
    return runtimeAuthor;
}
export function buildRuntimeAuthorWithShortAddress({ author, signaturePublicKey, shortAddress, community }) {
    return {
        ...buildRuntimeAuthor({ author, signaturePublicKey, community }),
        shortAddress
    };
}
//# sourceMappingURL=publication-author.js.map