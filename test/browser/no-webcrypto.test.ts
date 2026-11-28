import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../fixtures/signers.js";
import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";

// A browser has no crypto.subtle on an insecure origin (plain http that is not localhost), and neither does
// React Native's Hermes. CI serves the tests from http://localhost, a secure context, so nothing else in the
// suite runs pkc-js without WebCrypto. Here crypto.subtle is removed BEFORE pkc-js is imported, so the real
// runtime/browser/polyfill.ts installs its digest fallback and every client has to work with only that.
//
// An insecure origin also has no WebTransport: browsers expose it only in a secure context. It is removed here
// too, so the libp2p-js client has to reach peers over WSS alone, as it would on a real insecure origin.
//
// dist/ must not be imported statically in this file: a static import is evaluated before the lines below,
// while crypto.subtle still exists, and the fallback would never install.
Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true, writable: true });
Object.defineProperty(globalThis, "WebTransport", { value: undefined, configurable: true, writable: true });
const hadSubtleWhenPkcJsLoaded = Boolean(globalThis.crypto.subtle);
await import("../../dist/node/index.js");
const { getAvailablePKCConfigsToTestAgainst, publishRandomPost, resolveWhenConditionIsTrue } = await import(
    "../../dist/node/test/test-util.js"
);

const communityAddress = signers[0].address;
const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("pkc-js in a browser without crypto.subtle or WebTransport", () => {
    it("has no WebTransport, as on an insecure origin", () => {
        expect((globalThis as { WebTransport?: unknown }).WebTransport).to.equal(undefined);
    });

    it("installs a crypto.subtle that has only digest", () => {
        expect(hadSubtleWhenPkcJsLoaded).to.equal(false);
        expect(Object.keys(globalThis.crypto.subtle)).to.deep.equal(["digest"]);
    });

    // multiformats' browser sha2 hasher calls crypto.subtle.digest("SHA-256", data), the string form (#581)
    it(`the fallback hashes "SHA-256" given as a string`, async () => {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
        expect(toHex(digest)).to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    getAvailablePKCConfigsToTestAgainst().map((config) => {
        describe(`without crypto.subtle - ${config.name}`, () => {
            let pkc: PKCType;
            let postCid: string;

            beforeAll(async () => {
                pkc = await config.pkcInstancePromise();
            });

            afterAll(async () => {
                await pkc?.destroy();
            });

            it("creates a signer", async () => {
                const signer = await pkc.createSigner();
                expect(signer.address).to.be.a("string");
            });

            it("loads a community", async () => {
                const community = await pkc.createCommunity({ address: communityAddress });
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });
                expect(community.lastPostCid).to.be.a("string");
                postCid = community.lastPostCid!;
                await community.stop();
            });

            it("loads a comment and its CommentUpdate", async () => {
                const comment = await pkc.createComment({ cid: postCid });
                await comment.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => Boolean(comment.updatedAt) });
                expect(comment.signature).to.be.an("object");
                await comment.stop();
            });

            it("publishes a post", async () => {
                const post = await publishRandomPost({ communityAddress, pkc });
                expect(post.cid).to.be.a("string");
            });
        });
    });
});
