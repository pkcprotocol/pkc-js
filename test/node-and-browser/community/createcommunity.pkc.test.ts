import signers from "../../fixtures/signers.js";

import {
    getAvailablePKCConfigsToTestAgainst,
    isRpcFlagOn,
    jsonifyCommunityAndRemoveInternalProps,
    isRunningInBrowser,
    addStringToIpfs,
    mockPKCV2,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";

import * as remeda from "remeda";
import validCommunityJsonfiedFixture from "../../fixtures/signatures/community/valid_community_jsonfied.json" with { type: "json" };
import validCommunityJsonfiedOldWireFormatFixture from "../../fixtures/signatures/community/valid_community_jsonfied_old_wire_format.json" with { type: "json" };
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
const communityAddress = signers[0].address;
const namedCommunityAddress = "plebbit.bso";

getAvailablePKCConfigsToTestAgainst().map((config) =>
    describe.concurrent(`pkc.createCommunity - Remote (${config.name})`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
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
            const loadedCommunityJson = JSON.parse(JSON.stringify(loadedCommunity));
            const createdCommunityJson = JSON.parse(JSON.stringify(createdCommunity));
            expect(deterministicStringify(loadedCommunityJson)).to.equal(deterministicStringify(createdCommunityJson));
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
            const testPKC = await config.pkcInstancePromise();
            try {
                const loadedCommunity = await loadCommunityWithResolvedName(testPKC);
                const spread = { ...loadedCommunity };
                expect(spread.nameResolved).to.equal(true);

                const recreatedCommunity = await testPKC.createCommunity(spread);

                expect(recreatedCommunity.nameResolved).to.be.undefined;
                expect(recreatedCommunity.address).to.equal(loadedCommunity.address);
                expect(recreatedCommunity.name).to.equal(loadedCommunity.name);
                expect(recreatedCommunity.publicKey).to.equal(loadedCommunity.publicKey);
                expect(recreatedCommunity.raw.communityIpfs).to.deep.equal(loadedCommunity.raw.communityIpfs);
            } finally {
                await testPKC.destroy();
            }
        });

        it.sequential(
            "createCommunity from a JSON-stringified community does not restore top-level runtime-only nameResolved",
            async () => {
                const testPKC = await config.pkcInstancePromise();
                try {
                    const loadedCommunity = await loadCommunityWithResolvedName(testPKC);
                    const json = JSON.parse(JSON.stringify(loadedCommunity));
                    expect(json.nameResolved).to.equal(true);

                    const recreatedCommunity = await testPKC.createCommunity(json);

                    expect(recreatedCommunity.nameResolved).to.be.undefined;
                    expect(recreatedCommunity.address).to.equal(loadedCommunity.address);
                    expect(recreatedCommunity.name).to.equal(loadedCommunity.name);
                    expect(recreatedCommunity.publicKey).to.equal(loadedCommunity.publicKey);
                    expect(recreatedCommunity.raw.communityIpfs).to.deep.equal(loadedCommunity.raw.communityIpfs);
                } finally {
                    await testPKC.destroy();
                }
            }
        );

        it("createCommunity preserves runtime-only author.nameResolved in preloaded fixture pages", async () => {
            const communityJson = remeda.clone(validCommunityJsonfiedFixture);
            const sourceComment = communityJson.posts.pages.hot.comments[0];
            const sourceRawComment = (communityJson.raw.subplebbitIpfs || (communityJson.raw as Record<string, any>).communityIpfs).posts
                .pages.hot.comments[0];
            Object.assign(sourceComment.author, { nameResolved: true });

            expect(sourceComment.author).to.have.property("nameResolved", true);
            expect(sourceRawComment.comment.author).to.not.have.property("nameResolved");

            const recreatedCommunity = await pkc.createCommunity(communityJson);
            const recreatedComment = recreatedCommunity.posts.pages.hot.comments.find((comment) => comment.cid === sourceComment.cid);

            expect(recreatedComment, `Fixture comment ${sourceComment.cid} should exist after createCommunity rehydration`).to.exist;
            expect(recreatedComment!.author).to.have.property(
                "nameResolved",
                true,
                "createCommunity should preserve runtime-only author.nameResolved from parsed preloaded pages"
            );
        });

        it("createCommunity preserves runtime-only author.nameResolved in preloaded OLD-wire-format fixture pages", async () => {
            const communityJson = remeda.clone(validCommunityJsonfiedOldWireFormatFixture);
            const sourceComment = communityJson.posts.pages.hot.comments[0];
            const sourceRawComment = (communityJson.raw.subplebbitIpfs || (communityJson.raw as Record<string, any>).communityIpfs).posts
                .pages.hot.comments[0];
            Object.assign(sourceComment.author, { nameResolved: true });

            expect(sourceComment.author).to.have.property("nameResolved", true);
            expect(sourceRawComment.comment.author).to.not.have.property("nameResolved");

            const recreatedCommunity = await pkc.createCommunity(communityJson);
            const recreatedComment = recreatedCommunity.posts.pages.hot.comments.find((c) => c.cid === sourceComment.cid);

            expect(recreatedComment, `Fixture comment ${sourceComment.cid} should exist after createCommunity rehydration`).to.exist;
            expect(recreatedComment!.author).to.have.property(
                "nameResolved",
                true,
                "createCommunity should preserve runtime-only author.nameResolved from old-wire-format preloaded pages"
            );
        });

        it(`Community JSON props does not change by creating a Community object via pkc.createCommunity`, async () => {
            const communityJson = remeda.clone(validCommunityJsonfiedFixture);
            const communityObj = await pkc.createCommunity(remeda.clone(validCommunityJsonfiedFixture));
            expect(communityJson.lastPostCid).to.equal(communityObj.lastPostCid).and.to.be.a("string");
            expect(communityJson.pubsubTopic).to.equal(communityObj.pubsubTopic).and.to.be.a("string");
            expect(communityJson.address).to.equal(communityObj.address).and.to.be.a("string");
            expect(communityJson.statsCid).to.equal(communityObj.statsCid).and.to.be.a("string");
            expect(communityJson.createdAt).to.equal(communityObj.createdAt).and.to.be.a("number");
            expect(communityJson.updatedAt).to.equal(communityObj.updatedAt).and.to.be.a("number");
            expect(communityJson.encryption).to.deep.equal(communityObj.encryption).and.to.be.a("object");
            expect(communityJson.roles).to.deep.equal(communityObj.roles).and.to.be.a("object");
            expect(communityJson.signature).to.deep.equal(communityObj.signature).and.to.be.a("object");
            expect(communityJson.protocolVersion).to.equal(communityObj.protocolVersion).and.to.be.a("string");

            expect(communityJson.posts.pageCids).to.deep.equal(communityObj.posts.pageCids).and.to.be.a("object");

            const noInternalPropsCommunityObj = jsonifyCommunityAndRemoveInternalProps(communityObj);
            const noInternalPropsCommunityJson = jsonifyCommunityAndRemoveInternalProps(communityJson as unknown as RemoteCommunity);
            for (const key of Object.keys(noInternalPropsCommunityJson)) {
                expect(noInternalPropsCommunityJson[key]).to.deep.equal(noInternalPropsCommunityObj[key], `Mismatch for key: ${key}`);
            }

            for (const key of Object.keys(noInternalPropsCommunityObj)) {
                expect(noInternalPropsCommunityJson[key]).to.deep.equal(noInternalPropsCommunityObj[key], `Mismatch for key: ${key}`);
            }
        });

        it("createCommunity with old-wire-format fixture correctly derives communityAddress in pages", async () => {
            const communityJson = remeda.clone(validCommunityJsonfiedOldWireFormatFixture);
            const communityObj = await pkc.createCommunity(remeda.clone(validCommunityJsonfiedOldWireFormatFixture));

            // Top-level fields unaffected by wire format change
            expect(communityJson.lastPostCid).to.equal(communityObj.lastPostCid).and.to.be.a("string");
            expect(communityJson.address).to.equal(communityObj.address).and.to.be.a("string");
            expect(communityJson.posts.pageCids).to.deep.equal(communityObj.posts.pageCids).and.to.be.a("object");

            // After parsing old-wire-format through parsePagesIpfs, comments must have new-format fields
            const comment = communityObj.posts.pages.hot!.comments[0];
            expect(comment.communityAddress).to.be.a("string");
            expect(comment.shortCommunityAddress).to.be.a("string");
            expect(comment.communityAddress).to.equal(communityJson.address);
        });

        it("createCommunity does not throw when posts has empty pages/pageCids and no updatedAt", async () => {
            const community = await pkc.createCommunity({
                address: communityAddress,
                posts: { pages: {}, pageCids: {} }
            });
            expect(community.address).to.equal(communityAddress);
        });

        it("createCommunity does not throw when JSON.stringify'd community has empty posts and no updatedAt", async () => {
            // This is the actual plebones scenario: cached community with clients key, empty posts, no updatedAt
            const cachedCommunity = {
                address: communityAddress,
                clients: {},
                posts: { pages: {}, pageCids: {} },
                modQueue: { pageCids: {} },
                startedState: "stopped",
                state: "stopped",
                updatingState: "stopped"
            };
            const community = await pkc.createCommunity(cachedCommunity as any);
            expect(community.address).to.equal(communityAddress);
        });

        it("createCommunity does not throw when modQueue has empty pageCids and no updatedAt", async () => {
            const community = await pkc.createCommunity({
                address: communityAddress,
                modQueue: { pageCids: {} }
            });
            expect(community.address).to.equal(communityAddress);
        });

        it("comment._updateRepliesPostsInstance with empty replies pages/pageCids does not throw", async () => {
            const loadedCommunity = await pkc.createCommunity({ address: communityAddress });
            await loadedCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => typeof loadedCommunity.updatedAt === "number"
            });
            await loadedCommunity.stop();

            const post = loadedCommunity.posts.pages.hot!.comments[0];
            const comment = await pkc.createComment({ cid: post.cid, communityAddress: communityAddress });
            // updatedAt must be defined for _updateRepliesPostsInstance not to throw
            comment.updatedAt = Math.floor(Date.now() / 1000);
            // Should not throw with empty pages and pageCids
            comment._updateRepliesPostsInstance({ pages: {}, pageCids: {} } as any);
        });

        it("Remote community instance created with only address prop can call getPage", async () => {
            const actualCommunity = await pkc.createCommunity({ address: communityAddress });
            await actualCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: actualCommunity,
                predicate: async () => typeof actualCommunity.updatedAt === "number"
            });
            await actualCommunity.stop();

            expect(actualCommunity.createdAt).to.be.a("number");

            expect(actualCommunity.posts.pages.hot).to.be.a("object");
            const pageCid = await addStringToIpfs(JSON.stringify({ comments: [actualCommunity.posts.pages.hot.comments[0].raw] })); // get it somehow
            expect(pageCid).to.be.a("string");
            const newCommunity = await pkc.createCommunity({ address: actualCommunity.address });
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
