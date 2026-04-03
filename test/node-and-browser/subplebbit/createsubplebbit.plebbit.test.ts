import signers from "../../fixtures/signers.js";

import {
    getAvailablePlebbitConfigsToTestAgainst,
    isRpcFlagOn,
    jsonifySubplebbitAndRemoveInternalProps,
    isRunningInBrowser,
    addStringToIpfs,
    mockPlebbitV2,
    describeIfRpc,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";

import * as remeda from "remeda";
import validSubplebbitJsonfiedFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_jsonfied.json" with { type: "json" };
import validSubplebbitJsonfiedOldWireFormatFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_jsonfied_old_wire_format.json" with { type: "json" };
import { describe, it, beforeAll, afterAll } from "vitest";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { RemoteSubplebbit } from "../../../dist/node/subplebbit/remote-subplebbit.js";
const subplebbitAddress = signers[0].address;
const namedSubplebbitAddress = "plebbit.bso";

getAvailablePlebbitConfigsToTestAgainst().map((config) =>
    describe.concurrent(`plebbit.createSubplebbit - Remote (${config.name})`, async () => {
        let plebbit: PlebbitType;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`subplebbit = await createSubplebbit(await getSubplebbit(address))`, async () => {
            const loadedSubplebbit = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await loadedSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedSubplebbit,
                predicate: async () => typeof loadedSubplebbit.updatedAt === "number"
            });
            await loadedSubplebbit.stop();

            const createdSubplebbit = await plebbit.createSubplebbit(loadedSubplebbit);
            const createdSubplebbitJson = jsonifySubplebbitAndRemoveInternalProps(createdSubplebbit);
            const loadedSubplebbitJson = jsonifySubplebbitAndRemoveInternalProps(loadedSubplebbit);

            expect(loadedSubplebbitJson).to.deep.equal(createdSubplebbitJson);
        });

        it(`subplebbit = await createSubplebbit({...await getSubplebbit()})`, async () => {
            const loadedSubplebbit = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await loadedSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedSubplebbit,
                predicate: async () => typeof loadedSubplebbit.updatedAt === "number"
            });
            await loadedSubplebbit.stop();

            const spread = { ...loadedSubplebbit };
            const createdFromSpreadSubplebbit = await plebbit.createSubplebbit(spread);
            for (const key of Object.keys(loadedSubplebbit)) {
                expect(deterministicStringify((loadedSubplebbit as unknown as Record<string, unknown>)[key])).to.equal(
                    deterministicStringify((createdFromSpreadSubplebbit as unknown as Record<string, unknown>)[key]),
                    `Mismatch for key: ${key}`
                );
            }

            for (const key of Object.keys(createdFromSpreadSubplebbit)) {
                expect(deterministicStringify((loadedSubplebbit as unknown as Record<string, unknown>)[key])).to.equal(
                    deterministicStringify((createdFromSpreadSubplebbit as unknown as Record<string, unknown>)[key]),
                    `Mismatch for key: ${key}`
                );
            }
        });

        it(`subplebbit = await createSubplebbit(JSON.parse(JSON.stringify(await getSubplebbit())))`, async () => {
            const loadedSubplebbit = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await loadedSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedSubplebbit,
                predicate: async () => typeof loadedSubplebbit.updatedAt === "number"
            });
            await loadedSubplebbit.stop();

            const createdSubplebbit = await plebbit.createSubplebbit(JSON.parse(JSON.stringify(loadedSubplebbit)));
            const loadedSubJson = JSON.parse(JSON.stringify(loadedSubplebbit));
            const createdSubJson = JSON.parse(JSON.stringify(createdSubplebbit));
            expect(deterministicStringify(loadedSubJson)).to.equal(deterministicStringify(createdSubJson));
        });

        const loadSubplebbitWithResolvedName = async (testPlebbit: PlebbitType) => {
            const loadedSubplebbit = await testPlebbit.createSubplebbit({ address: namedSubplebbitAddress });
            await loadedSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedSubplebbit,
                predicate: async () => typeof loadedSubplebbit.updatedAt === "number"
            });
            loadedSubplebbit.nameResolved = true;
            expect(loadedSubplebbit.nameResolved).to.equal(true);
            await loadedSubplebbit.stop();

            return loadedSubplebbit;
        };

        it.sequential("createSubplebbit from a spread subplebbit does not restore top-level runtime-only nameResolved", async () => {
            const testPlebbit = await config.plebbitInstancePromise();
            try {
                const loadedSubplebbit = await loadSubplebbitWithResolvedName(testPlebbit);
                const spread = { ...loadedSubplebbit };
                expect(spread.nameResolved).to.equal(true);

                const recreatedSubplebbit = await testPlebbit.createSubplebbit(spread);

                expect(recreatedSubplebbit.nameResolved).to.be.undefined;
                expect(recreatedSubplebbit.address).to.equal(loadedSubplebbit.address);
                expect(recreatedSubplebbit.name).to.equal(loadedSubplebbit.name);
                expect(recreatedSubplebbit.publicKey).to.equal(loadedSubplebbit.publicKey);
                expect(recreatedSubplebbit.raw.subplebbitIpfs).to.deep.equal(loadedSubplebbit.raw.subplebbitIpfs);
            } finally {
                await testPlebbit.destroy();
            }
        });

        it.sequential(
            "createSubplebbit from a JSON-stringified subplebbit does not restore top-level runtime-only nameResolved",
            async () => {
                const testPlebbit = await config.plebbitInstancePromise();
                try {
                    const loadedSubplebbit = await loadSubplebbitWithResolvedName(testPlebbit);
                    const json = JSON.parse(JSON.stringify(loadedSubplebbit));
                    expect(json.nameResolved).to.equal(true);

                    const recreatedSubplebbit = await testPlebbit.createSubplebbit(json);

                    expect(recreatedSubplebbit.nameResolved).to.be.undefined;
                    expect(recreatedSubplebbit.address).to.equal(loadedSubplebbit.address);
                    expect(recreatedSubplebbit.name).to.equal(loadedSubplebbit.name);
                    expect(recreatedSubplebbit.publicKey).to.equal(loadedSubplebbit.publicKey);
                    expect(recreatedSubplebbit.raw.subplebbitIpfs).to.deep.equal(loadedSubplebbit.raw.subplebbitIpfs);
                } finally {
                    await testPlebbit.destroy();
                }
            }
        );

        it("createSubplebbit preserves runtime-only author.nameResolved in preloaded fixture pages", async () => {
            const subJson = remeda.clone(validSubplebbitJsonfiedFixture);
            const sourceComment = subJson.posts.pages.hot.comments[0];
            const sourceRawComment = subJson.raw.subplebbitIpfs.posts.pages.hot.comments[0];
            Object.assign(sourceComment.author, { nameResolved: true });

            expect(sourceComment.author).to.have.property("nameResolved", true);
            expect(sourceRawComment.comment.author).to.not.have.property("nameResolved");

            const recreatedSub = await plebbit.createSubplebbit(subJson);
            const recreatedComment = recreatedSub.posts.pages.hot.comments.find((comment) => comment.cid === sourceComment.cid);

            expect(recreatedComment, `Fixture comment ${sourceComment.cid} should exist after createSubplebbit rehydration`).to.exist;
            expect(recreatedComment!.author).to.have.property(
                "nameResolved",
                true,
                "createSubplebbit should preserve runtime-only author.nameResolved from parsed preloaded pages"
            );
        });

        it("createSubplebbit preserves runtime-only author.nameResolved in preloaded OLD-wire-format fixture pages", async () => {
            const subJson = remeda.clone(validSubplebbitJsonfiedOldWireFormatFixture);
            const sourceComment = subJson.posts.pages.hot.comments[0];
            const sourceRawComment = subJson.raw.subplebbitIpfs.posts.pages.hot.comments[0];
            Object.assign(sourceComment.author, { nameResolved: true });

            expect(sourceComment.author).to.have.property("nameResolved", true);
            expect(sourceRawComment.comment.author).to.not.have.property("nameResolved");

            const recreatedSub = await plebbit.createSubplebbit(subJson);
            const recreatedComment = recreatedSub.posts.pages.hot.comments.find((c) => c.cid === sourceComment.cid);

            expect(recreatedComment, `Fixture comment ${sourceComment.cid} should exist after createSubplebbit rehydration`).to.exist;
            expect(recreatedComment!.author).to.have.property(
                "nameResolved",
                true,
                "createSubplebbit should preserve runtime-only author.nameResolved from old-wire-format preloaded pages"
            );
        });

        it(`Sub JSON props does not change by creating a Subplebbit object via plebbit.createSubplebbit`, async () => {
            const subJson = remeda.clone(validSubplebbitJsonfiedFixture);
            const subObj = await plebbit.createSubplebbit(remeda.clone(validSubplebbitJsonfiedFixture));
            expect(subJson.lastPostCid).to.equal(subObj.lastPostCid).and.to.be.a("string");
            expect(subJson.pubsubTopic).to.equal(subObj.pubsubTopic).and.to.be.a("string");
            expect(subJson.address).to.equal(subObj.address).and.to.be.a("string");
            expect(subJson.statsCid).to.equal(subObj.statsCid).and.to.be.a("string");
            expect(subJson.createdAt).to.equal(subObj.createdAt).and.to.be.a("number");
            expect(subJson.updatedAt).to.equal(subObj.updatedAt).and.to.be.a("number");
            expect(subJson.encryption).to.deep.equal(subObj.encryption).and.to.be.a("object");
            expect(subJson.roles).to.deep.equal(subObj.roles).and.to.be.a("object");
            expect(subJson.signature).to.deep.equal(subObj.signature).and.to.be.a("object");
            expect(subJson.protocolVersion).to.equal(subObj.protocolVersion).and.to.be.a("string");

            expect(subJson.posts.pageCids).to.deep.equal(subObj.posts.pageCids).and.to.be.a("object");

            const noInternalPropsSubObj = jsonifySubplebbitAndRemoveInternalProps(subObj);
            const noInternalPropsSubJson = jsonifySubplebbitAndRemoveInternalProps(subJson as unknown as RemoteSubplebbit);
            for (const key of Object.keys(noInternalPropsSubJson)) {
                expect(noInternalPropsSubJson[key]).to.deep.equal(noInternalPropsSubObj[key], `Mismatch for key: ${key}`);
            }

            for (const key of Object.keys(noInternalPropsSubObj)) {
                expect(noInternalPropsSubJson[key]).to.deep.equal(noInternalPropsSubObj[key], `Mismatch for key: ${key}`);
            }
        });

        it("createSubplebbit with old-wire-format fixture correctly derives communityAddress in pages", async () => {
            const subJson = remeda.clone(validSubplebbitJsonfiedOldWireFormatFixture);
            const subObj = await plebbit.createSubplebbit(remeda.clone(validSubplebbitJsonfiedOldWireFormatFixture));

            // Top-level fields unaffected by wire format change
            expect(subJson.lastPostCid).to.equal(subObj.lastPostCid).and.to.be.a("string");
            expect(subJson.address).to.equal(subObj.address).and.to.be.a("string");
            expect(subJson.posts.pageCids).to.deep.equal(subObj.posts.pageCids).and.to.be.a("object");

            // After parsing old-wire-format through parsePagesIpfs, comments must have new-format fields
            const comment = subObj.posts.pages.hot!.comments[0];
            expect(comment.communityAddress).to.be.a("string");
            expect(comment.shortCommunityAddress).to.be.a("string");
            expect(comment.communityAddress).to.equal(subJson.address);
        });

        it("createSubplebbit does not throw when posts has empty pages/pageCids and no updatedAt", async () => {
            const sub = await plebbit.createSubplebbit({
                address: subplebbitAddress,
                posts: { pages: {}, pageCids: {} }
            });
            expect(sub.address).to.equal(subplebbitAddress);
        });

        it("createSubplebbit does not throw when JSON.stringify'd sub has empty posts and no updatedAt", async () => {
            // This is the actual plebones scenario: cached sub with clients key, empty posts, no updatedAt
            const cachedSub = {
                address: subplebbitAddress,
                clients: {},
                posts: { pages: {}, pageCids: {} },
                modQueue: { pageCids: {} },
                startedState: "stopped",
                state: "stopped",
                updatingState: "stopped"
            };
            const sub = await plebbit.createSubplebbit(cachedSub as any);
            expect(sub.address).to.equal(subplebbitAddress);
        });

        it("createSubplebbit does not throw when modQueue has empty pageCids and no updatedAt", async () => {
            const sub = await plebbit.createSubplebbit({
                address: subplebbitAddress,
                modQueue: { pageCids: {} }
            });
            expect(sub.address).to.equal(subplebbitAddress);
        });

        it("comment._updateRepliesPostsInstance with empty replies pages/pageCids does not throw", async () => {
            const loadedSub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await loadedSub.update();
            await resolveWhenConditionIsTrue({ toUpdate: loadedSub, predicate: async () => typeof loadedSub.updatedAt === "number" });
            await loadedSub.stop();

            const post = loadedSub.posts.pages.hot!.comments[0];
            const comment = await plebbit.createComment({ cid: post.cid, communityAddress: subplebbitAddress });
            // updatedAt must be defined for _updateRepliesPostsInstance not to throw
            comment.updatedAt = Math.floor(Date.now() / 1000);
            // Should not throw with empty pages and pageCids
            comment._updateRepliesPostsInstance({ pages: {}, pageCids: {} } as any);
        });

        it("Remote subplebbit instance created with only address prop can call getPage", async () => {
            const actualSub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await actualSub.update();
            await resolveWhenConditionIsTrue({ toUpdate: actualSub, predicate: async () => typeof actualSub.updatedAt === "number" });
            await actualSub.stop();

            expect(actualSub.createdAt).to.be.a("number");

            expect(actualSub.posts.pages.hot).to.be.a("object");
            const pageCid = await addStringToIpfs(JSON.stringify({ comments: [actualSub.posts.pages.hot.comments[0].raw] })); // get it somehow
            expect(pageCid).to.be.a("string");
            const newSubplebbit = await plebbit.createSubplebbit({ address: actualSub.address });
            expect(newSubplebbit.createdAt).to.be.undefined;

            const page = await newSubplebbit.posts.getPage({ cid: pageCid });
            expect(page.comments.length).to.be.greaterThan(0);
        });
    })
);

describe.concurrent(`plebbit.createSubplebbit - (remote) - errors`, async () => {
    let plebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockPlebbitV2({ remotePlebbit: true });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`plebbit.createSubplebbit({address}) throws if address if ENS and has a capital letter`, async () => {
        try {
            await plebbit.createSubplebbit({ address: "testSub.bso" });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER");
        }
    });

    it("plebbit.createSubplebbit({address}) throws if subplebbit address isn't an ipns or domain", async () => {
        const invalidAddress = "0xdeadbeef";
        try {
            await plebbit.createSubplebbit({ address: invalidAddress });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_INVALID_SUBPLEBBIT_ADDRESS_SCHEMA");
        }
    });
    if (!isRpcFlagOn() && isRunningInBrowser())
        it(`plebbit.createSubplebbit({}) should throw if no rpc and on browser`, async () => {
            try {
                await plebbit.createSubplebbit({});
                expect.fail("should fail");
            } catch (e) {
                expect((e as { code: string }).code).to.equal("ERR_INVALID_CREATE_REMOTE_SUBPLEBBIT_ARGS_SCHEMA");
            }
        });
});
