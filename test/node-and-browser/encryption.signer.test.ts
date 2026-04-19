import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fixtureSigners from "../fixtures/signers.js";
import type { SignerType, Encrypted } from "../../dist/node/signer/types.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";

const authorSignerFixture = fixtureSigners[1];
const communitySignerFixture = fixtureSigners[2];
import { comment as fixtureComment } from "../fixtures/publications.js";
import { encryptEd25519AesGcm, decryptEd25519AesGcm, encryptStringAesGcm, decryptStringAesGcm } from "../../dist/node/signer/encryption.js";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { mockRemotePKC } from "../../dist/node/test/test-util.js";
import * as ed from "@noble/ed25519";

describe("encryption", () => {
    let pkc: PKC;
    let authorSigner: SignerType;

    beforeAll(async function () {
        pkc = await mockRemotePKC();
        authorSigner = await pkc.createSigner({ privateKey: authorSignerFixture.privateKey, type: "ed25519" });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    describe("encrypt and decrypt string with aes-gcm", async () => {
        describe("generated key", () => {
            let key: Uint8Array;
            let ciphertext: Uint8Array;
            let iv: Uint8Array;
            let tag: Uint8Array;
            beforeAll(async () => {
                // key must be 16 bytes for aes-gcm 128
                key = ed.utils.randomPrivateKey().slice(0, 16);
                const res = await encryptStringAesGcm(JSON.stringify(fixtureComment), key);
                ciphertext = res.ciphertext;
                iv = res.iv;
                tag = res.tag;
            });

            it("ciphertext is not empty", async () => {
                expect(ciphertext.constructor.name).to.equal("Uint8Array");
                expect(ciphertext.length).to.not.equal(0);
            });

            it("iv is not empty", async () => {
                expect(iv.constructor.name).to.equal("Uint8Array");
                expect(iv.length).to.not.equal(0);
            });

            it("tag is not empty", async () => {
                expect(tag.constructor.name).to.equal("Uint8Array");
                expect(tag.length).to.not.equal(0);
            });

            it("encrypted string can be decrypted", async () => {
                const decryptedString = await decryptStringAesGcm(ciphertext, key, iv, tag);
                expect(decryptedString).to.be.a("string");
                expect(decryptedString).to.not.be.empty;
                expect(JSON.stringify(fixtureComment)).to.equal(decryptedString);
            });
        });

        describe("fixed key and iv", () => {
            // key must be 16 bytes for aes-gcm 128
            const key = uint8ArrayFromString("1111111111111111");
            // iv must be 12 bytes
            const iv = uint8ArrayFromString("111111111111");

            describe("encrypt the word 'string'", () => {
                const string = "string";
                let ciphertext: Uint8Array;
                let tag: Uint8Array;
                let resIv: Uint8Array;
                beforeAll(async () => {
                    const res = await encryptStringAesGcm(string, key, iv);
                    ciphertext = res.ciphertext;
                    tag = res.tag;
                    resIv = res.iv;
                });

                it("ciphertext is correct", async () => {
                    expect(ciphertext.constructor.name).to.equal("Uint8Array");
                    expect(ciphertext.length).to.not.equal(0);
                    expect(uint8ArrayToString(ciphertext, "base64")).to.equal("LjjTphzr");
                });

                it("iv is correct", async () => {
                    expect(resIv.constructor.name).to.equal("Uint8Array");
                    expect(resIv.length).to.not.equal(0);
                    expect(uint8ArrayToString(resIv)).to.equal(uint8ArrayToString(iv));
                });

                it("tag is correct", async () => {
                    expect(tag.constructor.name).to.equal("Uint8Array");
                    expect(tag.length).to.not.equal(0);
                    expect(uint8ArrayToString(tag, "base64")).to.equal("A+d3AWJ0NM/4t1OwLs0/lw");
                });

                it("encrypted string can be decrypted", async () => {
                    const decryptedString = await decryptStringAesGcm(ciphertext, key, iv, tag);
                    expect(decryptedString).to.be.a("string");
                    expect(decryptedString).to.not.be.empty;
                    expect(string).to.equal(decryptedString);
                });
            });

            describe("encrypt an emoji", () => {
                const emoji = "🤡";
                let ciphertext: Uint8Array;
                let tag: Uint8Array;
                beforeAll(async () => {
                    const res = await encryptStringAesGcm(emoji, key, iv);
                    ciphertext = res.ciphertext;
                    tag = res.tag;
                });

                it("encrypted emoji is not empty", async () => {
                    expect(ciphertext.constructor.name).to.equal("Uint8Array");
                    expect(ciphertext.length).to.not.equal(0);

                    // aes-gcm 128 encrypted "🤡" with key "1111111111111111" and iv "111111111111"
                    // should always return this value
                    expect(uint8ArrayToString(ciphertext, "base64")).to.equal("rdMFbg");
                });

                it("encrypted emoji can be decrypted", async () => {
                    const decryptedEmoji = await decryptStringAesGcm(ciphertext, key, iv, tag);
                    expect(decryptedEmoji).to.be.a("string");
                    expect(decryptedEmoji).to.not.be.empty;
                    expect(emoji).to.equal(decryptedEmoji);
                });
            });
        });
    });

    describe("encrypt and decrypt publication with ed25519 + aes-gcm", () => {
        let encryptedPublication: Encrypted;

        beforeAll(async () => {
            encryptedPublication = await encryptEd25519AesGcm(
                JSON.stringify(fixtureComment),
                authorSignerFixture.privateKey,
                communitySignerFixture.publicKey
            );
        });

        it("encrypted publication has expected properties", async () => {
            expect(encryptedPublication).to.not.equal(undefined);
            expect(encryptedPublication.ciphertext instanceof Uint8Array).to.equal(true);
            expect(encryptedPublication.ciphertext.length).to.be.greaterThan(0);
            expect(encryptedPublication.iv instanceof Uint8Array).to.equal(true);
            expect(encryptedPublication.iv.length).to.be.greaterThan(0);
            expect(encryptedPublication.tag instanceof Uint8Array).to.equal(true);
            expect(encryptedPublication.tag.length).to.be.greaterThan(0);
            expect(encryptedPublication.type).to.equal("ed25519-aes-gcm");
        });

        it("encrypted publication can be decrypted", async () => {
            const decryptedPublicationString = await decryptEd25519AesGcm(
                encryptedPublication,
                communitySignerFixture.privateKey,
                authorSignerFixture.publicKey
            );
            let decryptedPublication: typeof fixtureComment;
            try {
                decryptedPublication = JSON.parse(decryptedPublicationString);
            } catch (e) {
                throw Error(`decrypted publication isn't valid JSON: ${(e as Error).message}`);
            }
            expect(decryptedPublication.communityAddress).to.equal(fixtureComment.communityAddress);
            expect(decryptedPublication.timestamp).to.equal(fixtureComment.timestamp);
            expect(decryptedPublication.content).to.equal(fixtureComment.content);
            expect(decryptedPublication.author?.address).to.equal(fixtureComment.author.address);
        });
    });
});
