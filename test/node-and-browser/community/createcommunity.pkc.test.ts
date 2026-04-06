import signers from "../../fixtures/signers.js";

import {
    getAvailablePKCConfigsToTestAgainst,
    isRpcFlagOn,
    jsonifyCommunityAndRemoveInternalProps,
    isRunningInBrowser,
    addStringToIpfs,
    mockPKCV2,
    describeIfRpc,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";

import * as remeda from "remeda";
import validCommunityJsonfiedFixture from "../../fixtures/signatures/community/valid_subplebbit_jsonfied.json" with { type: "json" };
import validCommunityJsonfiedOldWireFormatFixture from "../../fixtures/signatures/community/valid_subplebbit_jsonfied_old_wire_format.json" with { type: "json" };
import { describe, it, beforeAll, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
const communityAddress = signers[0].address;
const namedCommunityAddress = "plebbit.bso";

getAvailablePKCConfigsToTestAgainst().map((config) =>
    describe.concurrent(`pkc.createCommunity - Remote (${config.name})`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community = await createCommunity(await getCommunity(address))`, async () => {
            const loadedCommunity = await pkc.createCommunity({ address: communityAddress });
            await loadedCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => typeof loadedCommunity.updatedAt === "number"
            });
            await loadedCommunity.stop();

            const createdCommunity = await pkc.createCommunity(loadedCommunity);
            const createdCommunityJson = jsonifyCommunityAndRemoveInternalProps(createdCommunity);
            const loadedCommunityJson = jsonifyCommunityAndRemoveInternalProps(loadedCommunity);

            expect(loadedCommunityJson).to.deep.equal(createdCommunityJson);
        });

        it(`community = await createCommunity({...await getCommunity()})`, async () => {
            const loadedCommunity = await pkc.createCommunity({ address: communityAddress });
            await loadedCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => typeof loadedCommunity.updatedAt === "number"
            });
            await loadedCommunity.stop();

            const spread = { ...loadedCommunity };
            const createdFromSpreadCommunity = await pkc.createCommunity(spread);
            for (const key of Object.keys(loadedCommunity)) {
                expect(deterministicStringify((loadedCommunity as unknown as Record<string, unknown>)[key])).to.equal(
                    deterministicStringify((createdFromSpreadCommunity as unknown as Record<string, unknown>)[key]),
                    `Mismatch for key: ${key}`
                );
            }

            for (const key of Object.keys(createdFromSpreadCommunity)) {
                expect(deterministicStringify((loadedCommunity as unknown as Record<string, unknown>)[key])).to.equal(
                    deterministicStringify((createdFromSpreadCommunity as unknown as Record<string, unknown>)[key]),
                    `Mismatch for key: ${key}`
                );
            }
        });

        it(`community = await createCommunity(JSON.parse(JSON.stringify(await getCommunity())))`, async () => {
            const loadedCommunity = await pkc.createCommunity({ address: communityAddress });
            await loadedCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => typeof loadedCommunity.updatedAt === "number"
            });
            await loadedCommunity.stop();

            const createdCommunity = await pkc.createCommunity(JSON.parse(JSON.stringify(loadedCommunity)));
            const loadedSubJson = JSON.parse(JSON.stringify(loadedCommunity));
            const createdSubJson = JSON.parse(JSON.stringify(createdCommunity));
            expect(deterministicStringify(loadedSubJson)).to.equal(deterministicStringify(createdSubJson));
        });

        const loadCommunityWithResolvedName = async (testPKC: PKCType) => {
            const loadedCommunity = await testPKC.createCommunity({ address: namedCommunityAddress });
            await loadedCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => typeof loadedCommunity.updatedAt === "number"
            });
            loadedCommunity.nameResolved = true;
            expect(loadedCommunity.nameResolved).to.equal(true);
            await loadedCommunity.stop();

            return loadedCommunity;
        };

        it.sequential("createCommunity from a spread community does not restore top-level runtime-only nameResolved", async () => {
            const testPKC = await config.plebbitInstancePromise();
            try {
                const loadedCommunity = await loadCommunityWithResolvedName(testPKC);
                const spread = { ...loadedCommunity };
                expect(spread.nameResolved).to.equal(true);

                const recreatedCommunity = await testPKC.createCommunity(spread);

                expect(recreatedCommunity.nameResolved).to.be.undefined;
                expect(recreatedCommunity.address).to.equal(loadedCommunity.address);
                expect(recreatedCommunity.name).to.equal(loadedCommunity.name);
                expect(recreatedCommunity.publicKey).to.equal(loadedCommunity.publicKey);
                expect(recreatedCommunity.raw.subplebbitIpfs).to.deep.equal(loadedCommunity.raw.subplebbitIpfs);
            } finally {
                await testPKC.destroy();
            }
        });

        it.sequential(
            "createCommunity from a JSON-stringified community does not restore top-level runtime-only nameResolved",
            async () => {
                const testPKC = await config.plebbitInstancePromise();
                try {
                    const loadedCommunity = await loadCommunityWithResolvedName(testPKC);
                    const json = JSON.parse(JSON.stringify(loadedCommunity));
                    expect(json.nameResolved).to.equal(true);

                    const recreatedCommunity = await testPKC.createCommunity(json);

                    expect(recreatedCommunity.nameResolved).to.be.undefined;
                    expect(recreatedCommunity.address).to.equal(loadedCommunity.address);
                    expect(recreatedCommunity.name).to.equal(loadedCommunity.name);
                    expect(recreatedCommunity.publicKey).to.equal(loadedCommunity.publicKey);
                    expect(recreatedCommunity.raw.subplebbitIpfs).to.deep.equal(loadedCommunity.raw.subplebbitIpfs);
                } finally {
                    await testPKC.destroy();
                }
            }
        );

        it("createCommunity preserves runtime-only author.nameResolved in preloaded fixture pages", async () => {
            const subJson = remeda.clone(validCommunityJsonfiedFixture);
            const sourceComment = subJson.posts.pages.hot.comments[0];
            const sourceRawComment = subJson.raw.subplebbitIpfs.posts.pages.hot.comments[0];
            Object.assign(sourceComment.author, { nameResolved: true });

            expect(sourceComment.author).to.have.property("nameResolved", true);
            expect(sourceRawComment.comment.author).to.not.have.property("nameResolved");

            const recreatedSub = await pkc.createCommunity(subJson);
            const recreatedComment = recreatedSub.posts.pages.hot.comments.find((comment) => comment.cid === sourceComment.cid);

            expect(recreatedComment, `Fixture comment ${sourceComment.cid} should exist after createCommunity rehydration`).to.exist;
            expect(recreatedComment!.author).to.have.property(
                "nameResolved",
                true,
                "createCommunity should preserve runtime-only author.nameResolved from parsed preloaded pages"
            );
        });

        it("createCommunity preserves runtime-only author.nameResolved in preloaded OLD-wire-format fixture pages", async () => {
            const subJson = remeda.clone(validCommunityJsonfiedOldWireFormatFixture);
            const sourceComment = subJson.posts.pages.hot.comments[0];
            const sourceRawComment = subJson.raw.subplebbitIpfs.posts.pages.hot.comments[0];
            Object.assign(sourceComment.author, { nameResolved: true });

            expect(sourceComment.author).to.have.property("nameResolved", true);
            expect(sourceRawComment.comment.author).to.not.have.property("nameResolved");

            const recreatedSub = await pkc.createCommunity(subJson);
            const recreatedComment = recreatedSub.posts.pages.hot.comments.find((c) => c.cid === sourceComment.cid);

            expect(recreatedComment, `Fixture comment ${sourceComment.cid} should exist after createCommunity rehydration`).to.exist;
            expect(recreatedComment!.author).to.have.property(
                "nameResolved",
                true,
                "createCommunity should preserve runtime-only author.nameResolved from old-wire-format preloaded pages"
            );
        });

        it(`Sub JSON props does not change by creating a Community object via pkc.createCommunity`, async () => {
            const subJson = remeda.clone(validCommunityJsonfiedFixture);
            const subObj = await pkc.createCommunity(remeda.clone(validCommunityJsonfiedFixture));
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

            const noInternalPropsSubObj = jsonifyCommunityAndRemoveInternalProps(subObj);
            const noInternalPropsSubJson = jsonifyCommunityAndRemoveInternalProps(subJson as unknown as RemoteCommunity);
            for (const key of Object.keys(noInternalPropsSubJson)) {
                expect(noInternalPropsSubJson[key]).to.deep.equal(noInternalPropsSubObj[key], `Mismatch for key: ${key}`);
            }

            for (const key of Object.keys(noInternalPropsSubObj)) {
                expect(noInternalPropsSubJson[key]).to.deep.equal(noInternalPropsSubObj[key], `Mismatch for key: ${key}`);
            }
        });

        it("createCommunity with old-wire-format fixture correctly derives communityAddress in pages", async () => {
            const subJson = remeda.clone(validCommunityJsonfiedOldWireFormatFixture);
            const subObj = await pkc.createCommunity(remeda.clone(validCommunityJsonfiedOldWireFormatFixture));

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

        it("createCommunity does not throw when posts has empty pages/pageCids and no updatedAt", async () => {
            const sub = await pkc.createCommunity({
                address: communityAddress,
                posts: { pages: {}, pageCids: {} }
            });
            expect(sub.address).to.equal(communityAddress);
        });

        it("createCommunity does not throw when JSON.stringify'd sub has empty posts and no updatedAt", async () => {
            // This is the actual plebones scenario: cached sub with clients key, empty posts, no updatedAt
            const cachedSub = {
                address: communityAddress,
                clients: {},
                posts: { pages: {}, pageCids: {} },
                modQueue: { pageCids: {} },
                startedState: "stopped",
                state: "stopped",
                updatingState: "stopped"
            };
            const sub = await pkc.createCommunity(cachedSub as any);
            expect(sub.address).to.equal(communityAddress);
        });

        it("createCommunity does not throw when modQueue has empty pageCids and no updatedAt", async () => {
            const sub = await pkc.createCommunity({
                address: communityAddress,
                modQueue: { pageCids: {} }
            });
            expect(sub.address).to.equal(communityAddress);
        });

        it("comment._updateRepliesPostsInstance with empty replies pages/pageCids does not throw", async () => {
            const loadedSub = await pkc.createCommunity({ address: communityAddress });
            await loadedSub.update();
            await resolveWhenConditionIsTrue({ toUpdate: loadedSub, predicate: async () => typeof loadedSub.updatedAt === "number" });
            await loadedSub.stop();

            const post = loadedSub.posts.pages.hot!.comments[0];
            const comment = await pkc.createComment({ cid: post.cid, communityAddress: communityAddress });
            // updatedAt must be defined for _updateRepliesPostsInstance not to throw
            comment.updatedAt = Math.floor(Date.now() / 1000);
            // Should not throw with empty pages and pageCids
            comment._updateRepliesPostsInstance({ pages: {}, pageCids: {} } as any);
        });

        it("Remote community instance created with only address prop can call getPage", async () => {
            const actualSub = await pkc.createCommunity({ address: communityAddress });
            await actualSub.update();
            await resolveWhenConditionIsTrue({ toUpdate: actualSub, predicate: async () => typeof actualSub.updatedAt === "number" });
            await actualSub.stop();

            expect(actualSub.createdAt).to.be.a("number");

            expect(actualSub.posts.pages.hot).to.be.a("object");
            const pageCid = await addStringToIpfs(JSON.stringify({ comments: [actualSub.posts.pages.hot.comments[0].raw] })); // get it somehow
            expect(pageCid).to.be.a("string");
            const newCommunity = await pkc.createCommunity({ address: actualSub.address });
            expect(newCommunity.createdAt).to.be.undefined;

            const page = await newCommunity.posts.getPage({ cid: pageCid });
            expect(page.comments.length).to.be.greaterThan(0);
        });
    })
);

describe.concurrent(`pkc.createCommunity - (remote) - errors`, async () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKCV2({ remotePKC: true });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`pkc.createCommunity({address}) throws if address if ENS and has a capital letter`, async () => {
        try {
            await pkc.createCommunity({ address: "testSub.bso" });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER");
        }
    });

    it("pkc.createCommunity({address}) throws if community address isn't an ipns or domain", async () => {
        const invalidAddress = "0xdeadbeef";
        try {
            await pkc.createCommunity({ address: invalidAddress });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_INVALID_COMMUNITY_ADDRESS_SCHEMA");
        }
    });
    if (!isRpcFlagOn() && isRunningInBrowser())
        it(`pkc.createCommunity({}) should throw if no rpc and on browser`, async () => {
            try {
                await pkc.createCommunity({});
                expect.fail("should fail");
            } catch (e) {
                expect((e as { code: string }).code).to.equal("ERR_INVALID_CREATE_REMOTE_COMMUNITY_ARGS_SCHEMA");
            }
        });
});
