import { privateKeyFromRaw, privateKeyToProtobuf, publicKeyFromRaw, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import PeerId from "peer-id";
import * as ed from "@noble/ed25519";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { CID } from "multiformats/cid";
import { bases } from "multiformats/basics";
import Logger from "../logger.js";

export const generatePrivateKey = async (): Promise<string> => {
    const privateKeyBuffer = ed.utils.randomPrivateKey();
    const privateKeyBase64 = uint8ArrayToString(privateKeyBuffer, "base64");
    return privateKeyBase64;
};

export const getPlebbitAddressFromPrivateKey = async (privateKeyBase64: string) => {
    const peerId = await getPeerIdFromPrivateKey(privateKeyBase64);
    return peerId.toB58String().trim();
};

export const getPlebbitAddressFromPublicKey = async (publicKeyBase64: string) => {
    const peerId = await getPeerIdFromPublicKey(publicKeyBase64);
    return peerId.toB58String().trim();
};

export const getPlebbitAddressFromPublicKeyBuffer = async (publicKeyBuffer: Uint8Array) => {
    // the PeerId public key is not a raw public key, it adds a suffix
    const peerId = await getPeerIdFromPublicKeyBuffer(publicKeyBuffer);

    return peerId.toB58String().trim();
};

export const getBufferedPlebbitAddressFromPublicKey = async (publicKeyBase64: string) => {
    const peerId = await getPeerIdFromPublicKey(publicKeyBase64);
    const buffered = uint8ArrayFromString(publicKeyBase64, "base64");

    return peerId.toBytes();
};

export const getIpfsKeyFromPrivateKey = async (privateKeyBase64: string) => {
    if (!privateKeyBase64 || typeof privateKeyBase64 !== "string") throw Error(`getIpfsKeyFromPrivateKey privateKeyBase64 not a string`);
    let privateKeyBuffer;
    try {
        privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
    } catch (e) {
        if (e instanceof Error) e.message = `getIpfsKeyFromPrivateKey privateKeyBase64 invalid: ${e.message}`;
        throw e;
    }
    if (privateKeyBuffer.length !== 32)
        throw Error(`getIpfsKeyFromPrivateKey privateKeyBase64 ed25519 private key length not 32 bytes (${privateKeyBuffer.length} bytes)`);
    const publicKeyBuffer = await ed.getPublicKey(privateKeyBuffer);

    // ipfs ed25519 private keys format are private (32 bytes) + public (32 bytes) (64 bytes total)
    const privateAndPublicKeyBuffer = new Uint8Array(64);
    privateAndPublicKeyBuffer.set(privateKeyBuffer);
    privateAndPublicKeyBuffer.set(publicKeyBuffer, 32);

    const ed25519PrivateKeyInstance = privateKeyFromRaw(privateAndPublicKeyBuffer);
    // the "ipfs key" adds a suffix, then the private key, then the public key, it is not the raw private key
    return privateKeyToProtobuf(ed25519PrivateKeyInstance);
};

export const getPublicKeyFromPrivateKey = async (privateKeyBase64: string) => {
    if (!privateKeyBase64 || typeof privateKeyBase64 !== "string") throw Error(`getPublicKeyFromPrivateKey privateKeyBase64 not a string`);
    let privateKeyBuffer;
    try {
        privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
    } catch (e) {
        if (e instanceof Error) e.message = `getPublicKeyFromPrivateKey privateKeyBase64 invalid: ${e.message}`;
        throw e;
    }
    if (privateKeyBuffer.length !== 32)
        throw Error(
            `getPublicKeyFromPrivateKey privateKeyBase64 ed25519 private key length not 32 bytes (${privateKeyBuffer.length} bytes)`
        );
    const publicKeyBuffer = await ed.getPublicKey(privateKeyBuffer);
    return uint8ArrayToString(publicKeyBuffer, "base64");
};

export const getPeerIdFromPrivateKey = async (privateKeyBase64: string) => {
    const ipfsKey = await getIpfsKeyFromPrivateKey(privateKeyBase64);
    // the PeerId private key is not a raw private key, it's an "ipfs key"
    const peerId = await PeerId.createFromPrivKey(ipfsKey);
    return peerId;
};

export const getPeerIdFromPublicKey = async (publicKeyBase64: string) => {
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string")
        throw Error(`getPeerIdFromPublicKey publicKeyBase64 '${publicKeyBase64}' not a string`);
    let publicKeyBuffer: Uint8Array;
    try {
        publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");
    } catch (e) {
        if (e instanceof Error) e.message = `getPeerIdFromPublicKey publicKeyBase64 invalid: ${e.message}`;
        throw e;
    }
    if (publicKeyBuffer.length !== 32)
        throw Error(
            `getPeerIdFromPublicKey publicKeyBase64 '${publicKeyBase64}' ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`
        );

    // the PeerId public key is not a raw public key, it adds a suffix
    const ed25519PublicKeyInstance = publicKeyFromRaw(publicKeyBuffer);
    const peerId = await PeerId.createFromPubKey(publicKeyToProtobuf(ed25519PublicKeyInstance));
    return peerId;
};

export const getPeerIdFromPublicKeyBuffer = async (publicKeyBuffer: Uint8Array) => {
    if (publicKeyBuffer.length !== 32)
        throw Error(
            `getPeerIdFromPublicKeyBuffer publicKeyBuffer ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`
        );

    // the PeerId public key is not a raw public key, it adds a suffix
    const ed25519PublicKeyInstance = publicKeyFromRaw(publicKeyBuffer);
    const peerId = await PeerId.createFromPubKey(publicKeyToProtobuf(ed25519PublicKeyInstance));
    return peerId;
};

export const convertBase58IpnsNameToBase36Cid = (ipnsName: string): string => {
    const log = Logger("plebbit-js:signer:util:convertBase58IpnsNameToBase32");
    let peerId: PeerId;
    try {
        peerId = PeerId.createFromB58String(ipnsName);
    } catch (error) {
        log.error("Error creating peer id from ipns name:", error);
        throw error;
    }

    try {
        return CID.parse(peerId.toString()).toString(bases.base36);
    } catch (e) {
        log.error(`Failed to convert peer id to CIDv1base36`, e);
        throw e;
    }
};

export function convertBase32ToBase58btc(base32String: string) {
    // Decode base32 to bytes
    const test = CID.parse(base32String);
    const peerId = PeerId.createFromBytes(test.bytes);
    return peerId.toB58String().trim();
}

export const getPlebbitAddressFromPublicKeySync = (publicKeyBase64: string): string => {
    // plebbit address is the base58 string of the peer id of the public key
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string")
        throw Error(`getPlebbitAddressFromPublicKeySync publicKeyBase64 '${publicKeyBase64}' not a string`);
    let publicKeyBuffer: Uint8Array;
    try {
        publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");
    } catch (e) {
        if (e instanceof Error) e.message = `getPlebbitAddressFromPublicKeySync publicKeyBase64 invalid: ${e.message}`;
        throw e;
    }
    if (publicKeyBuffer.length !== 32)
        throw Error(
            `getPlebbitAddressFromPublicKeySync publicKeyBase64 '${publicKeyBase64}' ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`
        );

    // Marshal to libp2p protobuf bytes to build the identity multihash
    const ed25519PublicKeyInstance = publicKeyFromRaw(publicKeyBuffer);
    const publicKeyBytes = publicKeyToProtobuf(ed25519PublicKeyInstance);

    // For Ed25519 keys, create identity hash multihash
    const multihash = new Uint8Array(2 + publicKeyBytes.length);
    multihash[0] = 0x00; // Identity hash code
    multihash[1] = publicKeyBytes.length; // digest length
    multihash.set(publicKeyBytes, 2); // the public key bytes themselves

    // Create PeerId from the multihash bytes and return as base58 string
    const peerId = PeerId.createFromBytes(multihash);
    return peerId.toB58String().trim();
};
