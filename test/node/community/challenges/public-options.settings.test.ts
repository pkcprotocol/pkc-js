import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockPKC, mockPKCNoDataPathWithOnlyKuboClient, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { ChallengeFileSchema } from "../../../../dist/node/community/schema.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { CommunityChallengeSetting } from "../../../../dist/node/community/types.js";

// settings.challenges[i].publicOptions names which of the challenge's private `options` the owner wants
// written into the published community record as community.challenges[i].publicOptions. Private is the
// default: an owner who names nothing publishes nothing. See docs/protocol/challenge-settings.md.
describe.concurrent(`community.settings.challenges[i].publicOptions`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    const startAndFetchRemote = async (community: LocalCommunity | RpcLocalCommunity) => {
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const remoteCommunity = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;
        expect(community.updatedAt).to.equal(remoteCommunity.updatedAt);
        return remoteCommunity;
    };

    it(`publishes only the options named in publicOptions, and never the rest`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        const challenges: CommunityChallengeSetting[] = [
            {
                name: "question",
                options: { question: "What is 2+2?", answer: "4" },
                publicOptions: ["question"]
            }
        ];
        await community.edit({ settings: { challenges } });

        // the private setting round-trips as the owner wrote it
        expect(community.settings!.challenges).to.deep.equal(challenges);

        const remoteCommunity = await startAndFetchRemote(community);
        for (const _community of [community, remoteCommunity]) {
            expect(_community.challenges![0].publicOptions).to.deep.equal({ question: "What is 2+2?" });
            // the answer is a secret and was not named, so it must not have leaked into the public record
            expect(_community.challenges![0].publicOptions).to.not.have.property("answer");
            // the raw private options object is never published, publicOptions or not
            expect(_community.challenges![0]).to.not.have.property("options");
        }
        await community.delete();
    });

    it(`omits publicOptions entirely when the owner names nothing`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        const challenges: CommunityChallengeSetting[] = [{ name: "question", options: { question: "What is 2+2?", answer: "4" } }];
        await community.edit({ settings: { challenges } });

        const remoteCommunity = await startAndFetchRemote(community);
        for (const _community of [community, remoteCommunity]) {
            // omitted, not an empty object: a record from an owner who opted into nothing stays
            // byte-identical to one produced before publicOptions existed
            expect(_community.challenges![0]).to.not.have.property("publicOptions");
        }
        await community.delete();
    });

    it(`skips named options the owner never set, and omits the field when none of them are set`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        const matches = `[{"propertyName":"author.address","regexp":"\\\\.bso$"}]`;
        // `error` is a declared option of publication-match that this owner left unset
        const challenges: CommunityChallengeSetting[] = [
            { name: "publication-match", options: { matches }, publicOptions: ["matches", "error"] }
        ];
        await community.edit({ settings: { challenges } });

        const remoteCommunity = await startAndFetchRemote(community);
        for (const _community of [community, remoteCommunity]) expect(_community.challenges![0].publicOptions).to.deep.equal({ matches });

        // naming only unset options publishes nothing at all rather than an empty object
        await community.edit({ settings: { challenges: [{ name: "publication-match", options: { matches }, publicOptions: ["error"] }] } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => !("publicOptions" in community.challenges![0])
        });
        expect(community.challenges![0]).to.not.have.property("publicOptions");
        await community.delete();
    });

    // ChallengeFileSchema was loosened from .strict() so that a challenge package shipping a newer optional
    // key still loads on an older node instead of failing to parse, which would take community startup down.
    it(`ChallengeFileSchema ignores unknown keys instead of throwing`, async () => {
        const challengeFile = {
            type: "text/plain",
            description: "a challenge from a newer package",
            getChallenge: async () => ({ success: true as const }),
            someKeyThisNodeDoesNotKnowAbout: () => {}
        };
        const parsed = ChallengeFileSchema.parse(challengeFile);
        expect(parsed.type).to.equal("text/plain");
        expect(parsed.description).to.equal("a challenge from a newer package");
        expect(parsed).to.have.property("someKeyThisNodeDoesNotKnowAbout");
    });
});
