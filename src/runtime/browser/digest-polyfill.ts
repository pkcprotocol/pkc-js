import { sha256 } from "js-sha256";
import { sha512 } from "js-sha512";

// Stands in for crypto.subtle.digest where WebCrypto is missing: an insecure browser origin, or a runtime
// such as React Native's Hermes. Like WebCrypto, it takes the algorithm as a string or as { name },
// case-insensitively (multiformats calls digest("SHA-256", data)), and resolves to an ArrayBuffer.
type DigestAlgorithm = string | { name: string };

export async function digestWithoutWebCrypto(algorithm: DigestAlgorithm, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
    const name = (typeof algorithm === "string" ? algorithm : algorithm?.name)?.toUpperCase();
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (name === "SHA-256") return sha256.arrayBuffer(bytes);
    if (name === "SHA-512") return sha512.arrayBuffer(bytes);
    throw new Error(`Unsupported digest algorithm ${JSON.stringify(algorithm)}: without WebCrypto only SHA-256 and SHA-512 are available`);
}
