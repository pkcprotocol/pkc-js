import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
// The polyfill is installed by the browser runtime only when crypto.subtle is missing (an insecure origin,
// React Native's Hermes), so its logic is tested here in Node against node:crypto.
import { digestWithoutWebCrypto } from "../../../dist/node/runtime/browser/digest-polyfill.js";

const data = new TextEncoder().encode("pkc-js digest polyfill");
const expectedHex = (algorithm: "sha256" | "sha512", bytes: Uint8Array) => createHash(algorithm).update(bytes).digest("hex");
const toHex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("hex");

describe("crypto.subtle.digest polyfill", () => {
    // multiformats' browser sha2 hasher calls crypto.subtle.digest("SHA-256", data). The polyfill used to
    // accept SHA-256 only as { name: "SHA-256" } and threw "Unsupported digest SHA-256" for the string.
    it("hashes SHA-256 given as a string, the form multiformats uses", async () => {
        const digest = await digestWithoutWebCrypto("SHA-256", data);
        expect(digest).to.be.instanceOf(ArrayBuffer);
        expect(toHex(digest)).to.equal(expectedHex("sha256", data));
    });

    it("hashes SHA-256 and SHA-512 given as { name }, case-insensitively", async () => {
        expect(toHex(await digestWithoutWebCrypto({ name: "SHA-256" }, data))).to.equal(expectedHex("sha256", data));
        expect(toHex(await digestWithoutWebCrypto({ name: "sha-512" }, data))).to.equal(expectedHex("sha512", data));
        expect(toHex(await digestWithoutWebCrypto("SHA-512", data))).to.equal(expectedHex("sha512", data));
    });

    it("hashes only the viewed bytes of a typed array or DataView, and accepts an ArrayBuffer", async () => {
        const padded = new Uint8Array(data.length + 8);
        padded.set(data, 4);
        const view = padded.subarray(4, 4 + data.length);
        expect(toHex(await digestWithoutWebCrypto("SHA-256", view))).to.equal(expectedHex("sha256", data));
        expect(toHex(await digestWithoutWebCrypto("SHA-256", new DataView(padded.buffer, 4, data.length)))).to.equal(
            expectedHex("sha256", data)
        );
        expect(toHex(await digestWithoutWebCrypto("SHA-256", data.slice().buffer))).to.equal(expectedHex("sha256", data));
    });

    it("hashes empty input", async () => {
        const empty = new Uint8Array(0);
        expect(toHex(await digestWithoutWebCrypto("SHA-256", empty))).to.equal(expectedHex("sha256", empty));
        expect(toHex(await digestWithoutWebCrypto("SHA-512", empty))).to.equal(expectedHex("sha512", empty));
    });

    it("rejects algorithms it cannot compute", async () => {
        await expect(digestWithoutWebCrypto("SHA-1", data)).rejects.toThrow(/Unsupported digest algorithm/);
        await expect(digestWithoutWebCrypto({ name: "SHA-1" }, data)).rejects.toThrow(/Unsupported digest algorithm/);
    });

    // a call that passes no usable algorithm must reject like WebCrypto does, not throw synchronously
    it("rejects a missing algorithm instead of throwing synchronously", async () => {
        const missingAlgorithm = undefined as unknown as string;
        const missingName = {} as unknown as { name: string };
        await expect(digestWithoutWebCrypto(missingAlgorithm, data)).rejects.toThrow(/Unsupported digest algorithm/);
        await expect(digestWithoutWebCrypto(missingName, data)).rejects.toThrow(/Unsupported digest algorithm/);
    });
});
