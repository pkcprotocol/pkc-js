import forge from "node-forge";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import type { Encrypted } from "./types.js";

const isProbablyBuffer = (arg: any) => arg && typeof arg !== "string" && typeof arg !== "number";

const uint8ArrayToNodeForgeBuffer = (uint8Array: Uint8Array) => {
    const forgeBuffer = forge.util.createBuffer();
    for (const byte of uint8Array) {
        forgeBuffer.putByte(byte);
    }
    return forgeBuffer;
};

// NOTE: never pass the last param 'iv', only used for testing, it must always be random
export const encryptStringAesGcm = async (plaintext: string, key: Uint8Array, iv?: Uint8Array) => {
    if (!plaintext || typeof plaintext !== "string") throw Error(`encryptStringAesGcm plaintext '${plaintext}' not a string`);
    if (!isProbablyBuffer(key)) throw Error(`encryptStringAesGcm invalid key '${key}' not buffer`);

    // use random 12 bytes uint8 array for iv
    if (!iv) {
        iv = ed25519.utils.randomSecretKey().slice(0, 12);
    }

    // node-forge doesn't accept uint8Array
    const keyAsForgeBuffer = uint8ArrayToNodeForgeBuffer(key);
    const ivAsForgeBuffer = uint8ArrayToNodeForgeBuffer(iv);

    const cipher = forge.cipher.createCipher("AES-GCM", keyAsForgeBuffer);
    cipher.start({ iv: ivAsForgeBuffer });
    cipher.update(forge.util.createBuffer(plaintext, "utf8"));
    cipher.finish();

    return {
        ciphertext: uint8ArrayFromString(cipher.output.toHex(), "base16"),
        iv,
        // AES-GCM has authentication tag https://en.wikipedia.org/wiki/Galois/Counter_Mode
        tag: uint8ArrayFromString(cipher.mode.tag.toHex(), "base16")
    };
};

export const decryptStringAesGcm = async (ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, tag: Uint8Array) => {
    if (!isProbablyBuffer(ciphertext)) throw Error(`decryptStringAesGcm invalid ciphertext '${ciphertext}' not buffer`);
    if (!isProbablyBuffer(key)) throw Error(`decryptStringAesGcm invalid key '${key}' not buffer`);
    if (!isProbablyBuffer(iv)) throw Error(`decryptStringAesGcm invalid iv '${iv}' not buffer`);
    if (!isProbablyBuffer(tag)) throw Error(`decryptStringAesGcm invalid tag '${tag}' not buffer`);

    // node-forge doesn't accept uint8Array
    const keyAsForgeBuffer = uint8ArrayToNodeForgeBuffer(key);
    const ivAsForgeBuffer = uint8ArrayToNodeForgeBuffer(iv);
    const tagAsForgeBuffer = uint8ArrayToNodeForgeBuffer(tag);

    const cipher = forge.cipher.createDecipher("AES-GCM", keyAsForgeBuffer);
    cipher.start({ iv: ivAsForgeBuffer, tag: tagAsForgeBuffer });
    cipher.update(uint8ArrayToNodeForgeBuffer(ciphertext));
    cipher.finish();
    const decrypted = cipher.output.toString();
    return decrypted;
};

export const encryptEd25519AesGcm = async (plaintext: string, privateKeyBase64: string, publicKeyBase64: string) => {
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string")
        throw Error(`encryptEd25519AesGcm publicKeyBase64 '${publicKeyBase64}' not a string`);
    const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");

    return encryptEd25519AesGcmPublicKeyBuffer(plaintext, privateKeyBase64, publicKeyBuffer);
};

export const encryptEd25519AesGcmPublicKeyBuffer = async (plaintext: string, privateKeyBase64: string, publicKeyBuffer: Uint8Array) => {
    if (!plaintext || typeof plaintext !== "string") throw Error(`encryptEd25519AesGcm plaintext '${plaintext}' not a string`);
    if (!privateKeyBase64 || typeof privateKeyBase64 !== "string") throw Error(`encryptEd25519AesGcm privateKeyBase64 not a string`);
    const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
    if (privateKeyBuffer.length !== 32)
        throw Error(`encryptEd25519AesGcm publicKeyBase64 ed25519 public key length not 32 bytes (${privateKeyBuffer.length} bytes)`);
    if (publicKeyBuffer.length !== 32)
        throw Error(
            `encryptEd25519AesGcm publicKeyBase64 '${publicKeyBuffer}' ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`
        );

    // add random padding to prevent linking encrypted publications by sizes
    // TODO: eventually use an algorithm to find the most anonymous padding length
    const randomPaddingLength = Math.round(Math.random() * 5000);
    let padding = "";
    while (padding.length < randomPaddingLength) {
        padding += " ";
    }

    // compute the shared secret of the sender and recipient and use it as the encryption key
    // do not publish this secret https://datatracker.ietf.org/doc/html/rfc7748#section-6.1
    const x25519Priv = ed25519.utils.toMontgomerySecret(privateKeyBuffer);
    const x25519Pub = ed25519.utils.toMontgomery(publicKeyBuffer);
    const aesGcmKey = x25519.getSharedSecret(x25519Priv, x25519Pub);
    // use 16 bytes key for AES-128
    const aesGcmKey16Bytes = aesGcmKey.slice(0, 16);

    // AES GCM using 128-bit key https://en.wikipedia.org/wiki/Galois/Counter_Mode
    const { ciphertext, iv, tag } = await encryptStringAesGcm(plaintext + padding, aesGcmKey16Bytes);

    const encrypted: Encrypted = {
        ciphertext,
        iv,
        // AES-GCM has authentication tag https://en.wikipedia.org/wiki/Galois/Counter_Mode
        tag,
        type: "ed25519-aes-gcm"
    };
    return encrypted;
};

export const decryptEd25519AesGcm = async (encrypted: Encrypted, privateKeyBase64: string, publicKeyBase64: string) => {
    if (!privateKeyBase64 || typeof privateKeyBase64 !== "string")
        throw Error(`decryptEd25519AesGcm ${privateKeyBase64} privateKeyBase64 not a string`);
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string")
        throw Error(`decryptEd25519AesGcm publicKeyBase64 '${publicKeyBase64}' not a string`);
    const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");

    return decryptEd25519AesGcmPublicKeyBuffer(encrypted, privateKeyBase64, publicKeyBuffer);
};

export const decryptEd25519AesGcmPublicKeyBuffer = async (encrypted: Encrypted, privateKeyBase64: string, publicKeyBuffer: Uint8Array) => {
    if (!privateKeyBase64 || typeof privateKeyBase64 !== "string")
        throw Error(`decryptEd25519AesGcm ${privateKeyBase64} privateKeyBase64 not a string`);
    const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
    if (privateKeyBuffer.length !== 32)
        throw Error(`decryptEd25519AesGcm publicKeyBase64 ed25519 public key length not 32 bytes (${privateKeyBuffer.length} bytes)`);
    if (publicKeyBuffer.length !== 32)
        throw Error(
            `decryptEd25519AesGcm publicKeyBuffer '${publicKeyBuffer}' ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`
        );

    // compute the shared secret of the sender and recipient and use it as the encryption key
    // do not publish this secret https://datatracker.ietf.org/doc/html/rfc7748#section-6.1
    const x25519Priv = ed25519.utils.toMontgomerySecret(privateKeyBuffer);
    const x25519Pub = ed25519.utils.toMontgomery(publicKeyBuffer);
    const aesGcmKey = x25519.getSharedSecret(x25519Priv, x25519Pub);
    // use 16 bytes key for AES-128
    const aesGcmKey16Bytes = aesGcmKey.slice(0, 16);

    // AES GCM using 128-bit key https://en.wikipedia.org/wiki/Galois/Counter_Mode
    let decrypted = await decryptStringAesGcm(encrypted.ciphertext, aesGcmKey16Bytes, encrypted.iv, encrypted.tag);

    // remove padding
    decrypted = decrypted.replace(/ *$/, "");

    return decrypted;
};
