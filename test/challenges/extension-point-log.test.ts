import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLogger } from "@pkcprotocol/pkc-logger";
import type { Logger } from "@pkcprotocol/pkc-logger";
import PKC from "../../dist/node/index.js";
import { getChallengeVerification } from "../../dist/node/runtime/node/community/challenges/index.js";
import { collectChallengeSettingsValidationFailures } from "../../dist/node/runtime/node/community/challenges/validate-challenge-settings.js";
import { resolvePageSortsAndCollectFailures } from "../../dist/node/runtime/node/community/page-sorts/index.js";
import { validateChallengeFileFactory } from "../../dist/node/challenges.js";
import { validatePageSortFileFactory } from "../../dist/node/page-sorts.js";
import { createMockNameResolver } from "../../dist/node/test/test-util.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeFileFactoryInput, PageSortFileFactoryInput } from "../../dist/node/community/types.js";
import signers from "../fixtures/signers.js";

// Issue #625: the `log` pkc-js hands to a challenge package, a page sort package and a name resolver is always
// passed, the validate hooks receive it too, and it carries the identifier of what it was created for
// (`challengeIndex`, `name`) on top of the owner's tags.

type SeenLog = { where: string; namespace: string; tags: Record<string, string> };

const seen = (where: string, log: Logger): SeenLog => ({ where, namespace: log.namespace, tags: { ...log.tags } });

const communityPublicKey = signers[0].address;

// A community's logger as LocalCommunity builds it: a child of the instance root tagged with the community's publicKey
const communityLog = (): Logger =>
    createLogger({ namespace: "pkc-js" }).child({ namespace: "local-community", tags: { publicKey: communityPublicKey } });

describe("the log handed to a challenge package (#625)", () => {
    const seenLogs: SeenLog[] = [];
    const captureChallenge: ChallengeFileFactoryInput = ({ log }) => {
        seenLogs.push(seen("factory", log));
        return {
            type: "text/plain",
            getChallenge: async ({ log }) => {
                seenLogs.push(seen("getChallenge", log));
                return { success: true };
            },
            validateChallengeSettings: ({ log }) => {
                seenLogs.push(seen("validateChallengeSettings", log));
            }
        };
    };
    const pkc = { settings: { challenges: { capture: captureChallenge } } };
    const challengeSettings = [{ name: "capture" }, { name: "capture" }];

    it("getChallenge receives a log tagged with the community's publicKey and its own challengeIndex", async () => {
        seenLogs.length = 0;
        const realPkc = await PKC({ httpRoutersOptions: [] });
        realPkc.settings = pkc.settings;
        const community = { _log: communityLog(), _pkc: realPkc, settings: { challenges: challengeSettings } };
        const challengeRequestMessage = {
            comment: { author: { address: signers[2].address }, signature: { publicKey: signers[2].publicKey } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const verification = await getChallengeVerification({
            challengeRequestMessage,
            community: community as unknown as LocalCommunity,
            getChallengeAnswers: async () => ({})
        });
        await realPkc.destroy();
        expect(verification.challengeSuccess).to.equal(true);

        const getChallengeLogs = seenLogs.filter((entry) => entry.where === "getChallenge");
        expect(getChallengeLogs.map((entry) => entry.tags.challengeIndex).sort()).to.deep.equal(["0", "1"]);
        for (const entry of getChallengeLogs) {
            expect(entry.tags.publicKey).to.equal(communityPublicKey);
            expect(entry.namespace).to.equal("pkc-js:local-community:capture");
        }
    });

    it("the factory and validateChallengeSettings receive a log under challenge:<name> with the entry's challengeIndex", async () => {
        seenLogs.length = 0;
        const failures = await collectChallengeSettingsValidationFailures({ challengeSettings, pkc, log: communityLog() });
        expect(failures).to.deep.equal([]);

        for (const where of ["factory", "validateChallengeSettings"]) {
            const entries = seenLogs.filter((entry) => entry.where === where);
            expect(
                entries.map((entry) => entry.tags.challengeIndex),
                where
            ).to.deep.equal(["0", "1"]);
            for (const entry of entries) {
                expect(entry.namespace, where).to.equal("pkc-js:local-community:challenge:capture");
                expect(entry.tags.publicKey, where).to.equal(communityPublicKey);
            }
        }
    });

    it("validateChallengeFileFactory passes the installer's log to the factory, under challenge:<name>", () => {
        seenLogs.length = 0;
        const installerLog = createLogger({ namespace: "installer" }).child({ namespace: "install" });
        validateChallengeFileFactory(captureChallenge, { name: "capture", log: installerLog });
        expect(seenLogs).to.deep.equal([{ where: "factory", namespace: "installer:install:challenge:capture", tags: {} }]);
    });
});

describe("the log handed to a page sort package (#625)", () => {
    const seenLogs: SeenLog[] = [];
    const capturePageSort: PageSortFileFactoryInput = ({ log }) => {
        seenLogs.push(seen("factory", log));
        return {
            sortName: "capture",
            description: "captures its log",
            score: () => 1,
            validatePageSortSettings: ({ log }) => {
                seenLogs.push(seen("validatePageSortSettings", log));
            }
        };
    };

    it("the factory and validatePageSortSettings receive a log under page-sort:<name> with the community's publicKey", async () => {
        seenLogs.length = 0;
        const { failures } = await resolvePageSortsAndCollectFailures({
            pagesSettings: { posts: [{ name: "capture" }] },
            pkc: { settings: { pageSorts: { capture: capturePageSort } } },
            log: communityLog()
        });
        expect(failures).to.deep.equal([]);
        expect(seenLogs.map((entry) => entry.where)).to.deep.equal(["factory", "validatePageSortSettings"]);
        for (const entry of seenLogs) {
            expect(entry.namespace, entry.where).to.equal("pkc-js:local-community:page-sort:capture");
            expect(entry.tags, entry.where).to.deep.equal({ publicKey: communityPublicKey });
        }
    });

    it("validatePageSortFileFactory passes the installer's log to the factory, under page-sort:<name>", () => {
        seenLogs.length = 0;
        const installerLog = createLogger({ namespace: "installer" }).child({ namespace: "install" });
        validatePageSortFileFactory(capturePageSort, { name: "capture", log: installerLog });
        expect(seenLogs).to.deep.equal([{ where: "factory", namespace: "installer:install:page-sort:capture", tags: {} }]);
    });
});

describe("the log handed to a name resolver (#625)", () => {
    const seenLogs: SeenLog[] = [];
    let pkc: Awaited<ReturnType<typeof PKC>>;

    beforeAll(async () => {
        pkc = await PKC({
            httpRoutersOptions: [],
            nameResolvers: [
                createMockNameResolver({
                    key: "capture-resolver",
                    resolveFunction: async ({ log }) => {
                        seenLogs.push(seen("resolve", log));
                        return { publicKey: communityPublicKey };
                    }
                })
            ]
        });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("resolve() receives a log under name-resolver:<key> tagged with the name being resolved", async () => {
        seenLogs.length = 0;
        // a name no earlier run resolved: a cached resolution would skip the resolver
        const communityName = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}.bso`;
        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName });
        expect(resolved).to.equal(communityPublicKey);
        expect(seenLogs).to.have.length(1);
        expect(seenLogs[0].tags.name).to.equal(communityName);
        expect(seenLogs[0].namespace.endsWith(":name-resolver:capture-resolver")).to.equal(true);
    });
});
