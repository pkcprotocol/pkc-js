import {
    createMockNameResolver,
    generateMockPost,
    getAvailablePKCConfigsToTestAgainst,
    publishStaticCommunityWithPostInPages,
    resolveWhenConditionIsTrue,
    selfResolvingMockNameForAddress
} from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { timestamp } from "../../../dist/node/util.js";
import { describe, it, expect, vi } from "vitest";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

// A community's name is a claim its record makes, and the record can stop making it: the owner drops
// the name or renames the community. What a loader does with such a record depends on what it asked for:
// - loaded by public key: the record is valid, and `name` (with `nameResolved` and the registry alias)
//   follows it, including to undefined. Seen in CI as a hang in name-dropped-comments.community.test.ts,
//   where the remote kept the old name forever.
// - loaded by name: the record does not describe the community the caller asked for. The loader refuses
//   it, keeps its last good record and emits the retriable ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME,
//   and accepts a later record that claims the name again.
// Loaders of both kinds share one internal updating instance, so each loader checks the name it asked for
// itself and a refusal never stops the shared instance or its other loaders.

// Typed as string so this suite type-checks against a build that predates the code
const MISMATCH_CODE: string = "ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME";

type StaticCommunity = Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;

// Signs a copy of `previous` with a newer updatedAt and the given name (undefined drops the field),
// and publishes it under the static community's key.
async function publishNewerRecord(opts: {
    staticCommunity: StaticCommunity;
    previous: CommunityIpfsType;
    name: string | undefined;
}): Promise<CommunityIpfsType> {
    const record: CommunityIpfsType = { ...opts.previous, updatedAt: Math.max(timestamp(), opts.previous.updatedAt + 1) };
    if (opts.name === undefined) delete record.name;
    else record.name = opts.name;
    record.signature = await signCommunity({ community: record, signer: opts.staticCommunity.ipnsObj.signer });
    await opts.staticCommunity.ipnsObj.publishToIpns(JSON.stringify(record));
    return record;
}

function collectMismatchErrors(community: RemoteCommunity): PKCError[] {
    const errors: PKCError[] = [];
    community.on("error", (error) => {
        if ((error as PKCError).code === MISMATCH_CODE) errors.push(error as PKCError);
    });
    return errors;
}

async function waitForUpdatedAt(community: RemoteCommunity, updatedAt: number) {
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt === updatedAt });
}

async function waitForMismatchCount(errors: PKCError[], count: number) {
    await vi.waitFor(() => expect(errors.length).to.be.greaterThanOrEqual(count), { timeout: 60_000, interval: 100 });
}

// The single internal updating instance every loader of the community mirrors
function onlyUpdatingEntry(pkc: PKCType): RemoteCommunity {
    const entries = pkc._updatingCommunities.values();
    expect(entries.length).to.equal(1);
    return entries[0] as RemoteCommunity;
}

const MIRROR_EVENTS = ["update", "error", "updatingstatechange", "statechange"] as const;

function listenerCounts(community: RemoteCommunity): Record<(typeof MIRROR_EVENTS)[number], number> {
    return {
        update: community.listenerCount("update"),
        error: community.listenerCount("error"),
        updatingstatechange: community.listenerCount("updatingstatechange"),
        statechange: community.listenerCount("statechange")
    };
}

function expectMismatchDetails(
    error: PKCError,
    expected: { requestedName: string; recordName: string | undefined; record: CommunityIpfsType; publicKey: string }
) {
    expect(error.code).to.equal(MISMATCH_CODE);
    expect(error.details.requestedName).to.equal(expected.requestedName);
    expect(error.details.recordName).to.equal(expected.recordName);
    expect(error.details.communityPublicKey).to.equal(expected.publicKey);
    expect(error.details.recordUpdatedAt).to.equal(expected.record.updatedAt);
    expect(error.details.retriableError).to.equal(true);
}

getAvailablePKCConfigsToTestAgainst({
    includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs", "remote-ipfs-gateway", "remote-pkc-rpc"]
}).map((config) => {
    describe(`A community record whose name does not match what the loader asked for - ${config.name}`, async () => {
        it(`a loader by public key clears name and nameResolved once a newer record drops the name`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const pkc = await config.pkcInstancePromise();
            try {
                const byKey = await pkc.createCommunity({ address: staticCommunity.communityAddress });
                await byKey.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byKey,
                    predicate: async () => byKey.updatedAt === staticCommunity.communityRecord.updatedAt && byKey.nameResolved === true
                });
                expect(byKey.name).to.equal(staticCommunity.communityName);

                const nameless = await publishNewerRecord({ staticCommunity, previous: staticCommunity.communityRecord, name: undefined });
                await waitForUpdatedAt(byKey, nameless.updatedAt);
                expect(byKey.raw.communityIpfs?.name).to.be.undefined;
                expect(byKey.name).to.be.undefined;
                expect(byKey.nameResolved).to.be.undefined;
                expect(byKey.address).to.equal(staticCommunity.communityAddress);
                expect(byKey.publicKey).to.equal(staticCommunity.communityAddress);
                await byKey.stop();
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        it(`a name the record dropped no longer routes new loaders to the by-key updating instance`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const communityName = staticCommunity.communityName!;
            const pkc = await config.pkcInstancePromise();
            try {
                const byKey = await pkc.createCommunity({ address: staticCommunity.communityAddress });
                await byKey.update();
                await waitForUpdatedAt(byKey, staticCommunity.communityRecord.updatedAt);
                const nameless = await publishNewerRecord({ staticCommunity, previous: staticCommunity.communityRecord, name: undefined });
                await waitForUpdatedAt(byKey, nameless.updatedAt);

                // Attaching by the dropped name would hand this loader a record that no longer claims it
                const byName = await pkc.createCommunity({ address: communityName });
                const mismatchErrors = collectMismatchErrors(byName);
                await byName.update();
                expect(pkc._updatingCommunities.size()).to.equal(2);
                // It loads the name itself and refuses the nameless record it finds
                await waitForMismatchCount(mismatchErrors, 1);
                expect(byName.updatedAt).to.be.undefined;
                await byName.stop();
                await byKey.stop();
                expect(pkc._updatingCommunities.size()).to.equal(0);
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        it(`before any record loads, name comes from the requested address`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const communityName = staticCommunity.communityName!;
            const pkc = await config.pkcInstancePromise();
            try {
                const byName = await pkc.createCommunity({ address: communityName });
                expect(byName.name).to.equal(communityName);
                const byNameAndKey = await pkc.createCommunity({ name: communityName, publicKey: staticCommunity.communityAddress });
                expect(byNameAndKey.name).to.equal(communityName);
                const byKey = await pkc.createCommunity({ address: staticCommunity.communityAddress });
                expect(byKey.name).to.be.undefined;
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        for (const loadBy of ["address", "name and publicKey"] as const) {
            it(`a loader by ${loadBy} refuses a record without its name, keeps the last good one, and recovers when the name returns`, async () => {
                const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
                const communityName = staticCommunity.communityName!;
                const pkc = await config.pkcInstancePromise();
                try {
                    const byName = await pkc.createCommunity(
                        loadBy === "address"
                            ? { address: communityName }
                            : { name: communityName, publicKey: staticCommunity.communityAddress }
                    );
                    const mismatchErrors = collectMismatchErrors(byName);
                    await byName.update();
                    await waitForUpdatedAt(byName, staticCommunity.communityRecord.updatedAt);

                    const nameless = await publishNewerRecord({
                        staticCommunity,
                        previous: staticCommunity.communityRecord,
                        name: undefined
                    });
                    await waitForMismatchCount(mismatchErrors, 1);
                    expectMismatchDetails(mismatchErrors[0], {
                        requestedName: communityName,
                        recordName: undefined,
                        record: nameless,
                        publicKey: staticCommunity.communityAddress
                    });
                    expect(byName.state).to.equal("updating");
                    expect(byName.updatedAt).to.equal(staticCommunity.communityRecord.updatedAt);
                    expect(byName.raw.communityIpfs?.updatedAt).to.equal(staticCommunity.communityRecord.updatedAt);
                    expect(byName.name).to.equal(communityName);
                    expect(byName.address).to.equal(communityName);

                    const named = await publishNewerRecord({ staticCommunity, previous: nameless, name: communityName });
                    await waitForUpdatedAt(byName, named.updatedAt);
                    expect(byName.name).to.equal(communityName);
                    expect(byName.state).to.equal("updating");
                    await byName.stop();
                    expect(pkc._updatingCommunities.size()).to.equal(0);
                } finally {
                    await pkc.destroy();
                    await staticCommunity.ipnsObj.pkc.destroy();
                }
            });
        }

        it(`a loader by name refuses a record that claims a different name`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const communityName = staticCommunity.communityName!;
            const pkc = await config.pkcInstancePromise();
            try {
                const byName = await pkc.createCommunity({ address: communityName });
                const mismatchErrors = collectMismatchErrors(byName);
                await byName.update();
                await waitForUpdatedAt(byName, staticCommunity.communityRecord.updatedAt);

                const newName = `renamed-${Date.now()}-${Math.floor(Math.random() * 1e6)}.bso`;
                const renamed = await publishNewerRecord({ staticCommunity, previous: staticCommunity.communityRecord, name: newName });
                await waitForMismatchCount(mismatchErrors, 1);
                expectMismatchDetails(mismatchErrors[0], {
                    requestedName: communityName,
                    recordName: newName,
                    record: renamed,
                    publicKey: staticCommunity.communityAddress
                });
                expect(byName.name).to.equal(communityName);
                expect(byName.updatedAt).to.equal(staticCommunity.communityRecord.updatedAt);
                expect(byName.state).to.equal("updating");
                await byName.stop();
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        it(`a refused record is reported once, not once per update cycle`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const communityName = staticCommunity.communityName!;
            const pkc = await config.pkcInstancePromise();
            try {
                const byName = await pkc.createCommunity({ address: communityName });
                const mismatchErrors = collectMismatchErrors(byName);
                await byName.update();
                await waitForUpdatedAt(byName, staticCommunity.communityRecord.updatedAt);
                await publishNewerRecord({ staticCommunity, previous: staticCommunity.communityRecord, name: undefined });
                await waitForMismatchCount(mismatchErrors, 1);
                // Several update cycles at the test updateInterval (500ms) on the same refused record
                await new Promise((resolve) => setTimeout(resolve, 5000));
                expect(mismatchErrors.length).to.equal(1);
                await byName.stop();
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        for (const firstLoader of ["by key", "by name"] as const) {
            it(`with the ${firstLoader} loader attached first, the by-key loader follows a nameless record while the by-name loader refuses it`, async () => {
                const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
                const communityName = staticCommunity.communityName!;
                const pkc = await config.pkcInstancePromise();
                try {
                    const byKey = await pkc.createCommunity({ address: staticCommunity.communityAddress });
                    const byName = await pkc.createCommunity({ address: communityName });
                    const byNameMismatchErrors = collectMismatchErrors(byName);
                    const byKeyMismatchErrors = collectMismatchErrors(byKey);
                    const [first, second] = firstLoader === "by key" ? [byKey, byName] : [byName, byKey];
                    await first.update();
                    await waitForUpdatedAt(first, staticCommunity.communityRecord.updatedAt);
                    const countsBeforeSecond = listenerCounts(onlyUpdatingEntry(pkc));
                    await second.update();
                    await waitForUpdatedAt(second, staticCommunity.communityRecord.updatedAt);
                    const sharedEntry = onlyUpdatingEntry(pkc);

                    const nameless = await publishNewerRecord({
                        staticCommunity,
                        previous: staticCommunity.communityRecord,
                        name: undefined
                    });
                    await waitForUpdatedAt(byKey, nameless.updatedAt);
                    await waitForMismatchCount(byNameMismatchErrors, 1);
                    expect(byKey.name).to.be.undefined;
                    expect(byName.name).to.equal(communityName);
                    expect(byName.updatedAt).to.equal(staticCommunity.communityRecord.updatedAt);

                    // The shared instance keeps running for the by-key loader
                    const newerNameless = await publishNewerRecord({ staticCommunity, previous: nameless, name: undefined });
                    await waitForUpdatedAt(byKey, newerNameless.updatedAt);
                    await waitForMismatchCount(byNameMismatchErrors, 2);
                    expect(byKeyMismatchErrors).to.have.length(0);
                    expect(byKey.state).to.equal("updating");
                    expect(byName.state).to.equal("updating");
                    expect(onlyUpdatingEntry(pkc)).to.equal(sharedEntry);

                    // Stopping the refusing loader detaches it fully and leaves the other one running
                    await second.stop();
                    expect(listenerCounts(onlyUpdatingEntry(pkc))).to.deep.equal(countsBeforeSecond);
                    await first.stop();
                    expect(pkc._updatingCommunities.size()).to.equal(0);
                } finally {
                    await pkc.destroy();
                    await staticCommunity.ipnsObj.pkc.destroy();
                }
            });
        }

        it(`a by-name loader joining after a nameless record loaded does not adopt it and gets the error on update()`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const communityName = staticCommunity.communityName!;
            const pkc = await config.pkcInstancePromise();
            try {
                const byKey = await pkc.createCommunity({ address: staticCommunity.communityAddress });
                await byKey.update();
                await waitForUpdatedAt(byKey, staticCommunity.communityRecord.updatedAt);
                const nameless = await publishNewerRecord({ staticCommunity, previous: staticCommunity.communityRecord, name: undefined });
                await waitForUpdatedAt(byKey, nameless.updatedAt);

                // Matches the running instance by public key
                const byName = await pkc.createCommunity({ name: communityName, publicKey: staticCommunity.communityAddress });
                expect(byName.updatedAt).to.be.undefined;
                const mismatchErrors = collectMismatchErrors(byName);
                let updatesWithRecord = 0;
                byName.on("update", () => {
                    if (byName.raw.communityIpfs) updatesWithRecord++;
                });
                await byName.update();
                await waitForMismatchCount(mismatchErrors, 1);
                expectMismatchDetails(mismatchErrors[0], {
                    requestedName: communityName,
                    recordName: undefined,
                    record: nameless,
                    publicKey: staticCommunity.communityAddress
                });
                expect(byName.updatedAt).to.be.undefined;
                expect(byName.name).to.equal(communityName);
                expect(updatesWithRecord).to.equal(0);
                await byName.stop();
                await byKey.stop();
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        // Alone, the restarted loader gets a new updating instance; with a by-key sibling keeping the shared
        // instance running, it mirrors that instance again and is replayed the record it already refused
        for (const sibling of ["no sibling", "a by-key sibling"] as const) {
            it(`a refused record is reported again after stop() and update(), with ${sibling}`, async () => {
                const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
                const communityName = staticCommunity.communityName!;
                const pkc = await config.pkcInstancePromise();
                try {
                    const byKey =
                        sibling === "a by-key sibling"
                            ? await pkc.createCommunity({ address: staticCommunity.communityAddress })
                            : undefined;
                    if (byKey) {
                        await byKey.update();
                        await waitForUpdatedAt(byKey, staticCommunity.communityRecord.updatedAt);
                    }
                    // With a sibling, load by name and key so the restart matches the shared instance by key
                    const byName = await pkc.createCommunity(
                        byKey ? { name: communityName, publicKey: staticCommunity.communityAddress } : { address: communityName }
                    );
                    const mismatchErrors = collectMismatchErrors(byName);
                    await byName.update();
                    await waitForUpdatedAt(byName, staticCommunity.communityRecord.updatedAt);
                    const nameless = await publishNewerRecord({
                        staticCommunity,
                        previous: staticCommunity.communityRecord,
                        name: undefined
                    });
                    await waitForMismatchCount(mismatchErrors, 1);
                    if (byKey) await waitForUpdatedAt(byKey, nameless.updatedAt);

                    // A restarted loader gets the same record again and must be told why it is refused,
                    // like a restarted loader of a migrated community is told about the migration again
                    await byName.stop();
                    await byName.update();
                    await vi.waitFor(() => expect(mismatchErrors.length).to.equal(2), { timeout: 30_000, interval: 100 });
                    expectMismatchDetails(mismatchErrors[1], {
                        requestedName: communityName,
                        recordName: undefined,
                        record: nameless,
                        publicKey: staticCommunity.communityAddress
                    });
                    await byName.stop();
                    if (byKey) {
                        // The refusing loader detached fully and left the by-key loader on the one shared instance
                        expect(pkc._updatingCommunities.size()).to.equal(1);
                        await byKey.stop();
                    }
                } finally {
                    await pkc.destroy();
                    await staticCommunity.ipnsObj.pkc.destroy();
                }
            });
        }

        // The record claims `<key>.bso`; `<key>.eth` is an alias of it (areEquivalentNames), so a loader of
        // either accepts the record. The `.bso` loader is the control for the alias one.
        for (const requestedTld of ["bso", "eth"] as const) {
            it(`a loader by the record's name as .${requestedTld} keeps nameResolved and its registry entry`, async () => {
                const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
                const recordName = staticCommunity.communityName!;
                expect(recordName.endsWith(".bso")).to.be.true;
                const requestedName = recordName.slice(0, -".bso".length) + "." + requestedTld;
                const pkc = await config.pkcInstancePromise();
                try {
                    const first = await pkc.createCommunity({ address: requestedName });
                    const mismatchErrors = collectMismatchErrors(first);
                    await first.update();
                    await waitForUpdatedAt(first, staticCommunity.communityRecord.updatedAt);
                    await vi.waitFor(() => expect(first.nameResolved).to.equal(true), { timeout: 30_000, interval: 100 });
                    expect(mismatchErrors).to.have.length(0);

                    // A second loader of the same name finds the running instance instead of starting another
                    const second = await pkc.createCommunity({ address: requestedName });
                    await second.update();
                    await waitForUpdatedAt(second, staticCommunity.communityRecord.updatedAt);
                    expect(pkc._updatingCommunities.size()).to.equal(1);
                    expect(second.nameResolved).to.equal(true);

                    await second.stop();
                    await first.stop();
                } finally {
                    await pkc.destroy();
                    await staticCommunity.ipnsObj.pkc.destroy();
                }
            });
        }

        // A publication addressed to a name must not be sent once the community's record stops claiming it
        // (docs/protocol/names-and-addresses.md). With a by-key loader updating, the publishing caches were
        // filled from the record that still claimed the name, so they must not answer for it afterwards.
        // "addressed by key and name": communityAddress is the key and communityName the name. The address is derived
        // from them (the name when there is one), so it must not look the community up under the key
        for (const cacheState of [
            "nothing cached",
            "a by-key loader updating",
            "a by-key loader updating, addressed by key and name"
        ] as const) {
            it(`publish() to a name the record no longer claims fails with the mismatch error, with ${cacheState}`, async () => {
                const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
                const communityName = staticCommunity.communityName!;
                const pkc = await config.pkcInstancePromise();
                try {
                    let byKey: RemoteCommunity | undefined;
                    if (cacheState !== "nothing cached") {
                        byKey = await pkc.createCommunity({ address: staticCommunity.communityAddress });
                        await byKey.update();
                        await waitForUpdatedAt(byKey, staticCommunity.communityRecord.updatedAt);
                    }
                    const nameless = await publishNewerRecord({
                        staticCommunity,
                        previous: staticCommunity.communityRecord,
                        name: undefined
                    });
                    if (byKey) await waitForUpdatedAt(byKey, nameless.updatedAt);

                    const post = await generateMockPost(
                        cacheState === "a by-key loader updating, addressed by key and name"
                            ? { communityAddress: staticCommunity.communityAddress, pkc, postProps: { communityName } }
                            : { communityAddress: communityName, pkc }
                    );
                    expect(post.communityAddress).to.equal(communityName);
                    try {
                        const error = await post.publish().then(
                            (): undefined => undefined,
                            (e: PKCError) => e
                        );
                        expect(error?.code).to.equal(MISMATCH_CODE);
                    } finally {
                        await post.stop();
                    }
                    if (byKey) await byKey.stop();
                } finally {
                    await pkc.destroy();
                    await staticCommunity.ipnsObj.pkc.destroy();
                }
            });
        }

        // A record makes claims, a resolved name proves them. The updating instance a loader of name A attached to
        // accepts any record signed by A's key, including one that claims another community's name B. That claim must
        // not route a later loader of B to this instance: B resolves to another key.
        it(`a record claiming another community's name does not capture the loaders of that name`, async () => {
            const claimant = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const owner = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const ownerName = owner.communityName!;
            const pkc = await config.pkcInstancePromise();
            try {
                const byClaimantName = await pkc.createCommunity({ address: claimant.communityName! });
                const mismatchErrors = collectMismatchErrors(byClaimantName);
                await byClaimantName.update();
                await waitForUpdatedAt(byClaimantName, claimant.communityRecord.updatedAt);
                await publishNewerRecord({ staticCommunity: claimant, previous: claimant.communityRecord, name: ownerName });
                await waitForMismatchCount(mismatchErrors, 1);

                const byOwnerName = await pkc.createCommunity({ address: ownerName });
                await byOwnerName.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byOwnerName,
                    predicate: async () => typeof byOwnerName.updatedAt === "number"
                });
                expect(byOwnerName.publicKey).to.equal(owner.communityAddress);
                await vi.waitFor(() => expect(byOwnerName.nameResolved).to.equal(true), { timeout: 30_000, interval: 100 });
                expect(byOwnerName.publicKey).to.equal(owner.communityAddress);
                await byOwnerName.stop();
                await byClaimantName.stop();
            } finally {
                await pkc.destroy();
                await claimant.ipnsObj.pkc.destroy();
                await owner.ipnsObj.pkc.destroy();
            }
        });

        // A comment signed while the community claimed a name carries that name for good, but its CommentUpdates are
        // signed by the community key. Once the record drops the name, the comment's own community loader (by name and
        // key, from the CommentIpfs) must still accept it, or the comment never updates again.
        it(`a comment signed under a name the record later dropped still gets its CommentUpdate`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages({
                withSelfResolvingName: true,
                withCommentsClaimingName: true
            });
            const communityName = staticCommunity.communityName!;
            const pkc = await config.pkcInstancePromise();
            try {
                // Without the pages: their comments claim the dropped name. The post's CommentUpdate stays reachable
                // through postUpdates.
                const nameless: CommunityIpfsType = {
                    ...staticCommunity.communityRecord,
                    updatedAt: Math.max(timestamp(), staticCommunity.communityRecord.updatedAt + 1)
                };
                delete nameless.name;
                delete nameless.posts;
                nameless.signature = await signCommunity({ community: nameless, signer: staticCommunity.ipnsObj.signer });
                await staticCommunity.ipnsObj.publishToIpns(JSON.stringify(nameless));

                const comment = await pkc.createComment({ cid: staticCommunity.commentCid });
                const mismatchErrors: PKCError[] = [];
                comment.on("error", (error) => {
                    if ((error as PKCError).code === MISMATCH_CODE) mismatchErrors.push(error as PKCError);
                });
                await comment.update();
                try {
                    await vi.waitFor(() => expect(typeof comment.updatedAt).to.equal("number"), { timeout: 30_000, interval: 100 });
                    expect(comment.communityName).to.equal(communityName);
                    expect(mismatchErrors).to.deep.equal([]);
                } finally {
                    await comment.stop();
                }
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        // A comment's community is loaded by key, and its communityName is resolved in parallel with that load. Once the
        // record dropped the name, whoever holds it now (here: another community's key) says nothing about this
        // community, so the resolve must not be taken as a key migration that wipes the record and its CommentUpdates.
        // Skipped under RPC: the name resolvers run on the RPC server, so a resolver configured here is never asked.
        it.skipIf(config.testConfigCode === "remote-pkc-rpc")(
            `a comment resolves its community name in parallel, and a dropped name now held by another key is not a migration`,
            async () => {
                const staticCommunity = await publishStaticCommunityWithPostInPages({
                    withSelfResolvingName: true,
                    withCommentsClaimingName: true
                });
                const otherCommunity = await publishStaticCommunityWithPostInPages();
                const communityName = staticCommunity.communityName!;
                const resolvedNames: string[] = [];
                const capturingResolver = createMockNameResolver({
                    resolveFunction: async ({ name }) => {
                        resolvedNames.push(name);
                        return name === communityName ? { publicKey: otherCommunity.communityAddress } : undefined;
                    }
                });
                const pkc = await config.pkcInstancePromise({ pkcOptions: { nameResolvers: [capturingResolver] } });
                try {
                    const nameless: CommunityIpfsType = {
                        ...staticCommunity.communityRecord,
                        updatedAt: Math.max(timestamp(), staticCommunity.communityRecord.updatedAt + 1)
                    };
                    delete nameless.name;
                    delete nameless.posts;
                    nameless.signature = await signCommunity({ community: nameless, signer: staticCommunity.ipnsObj.signer });
                    await staticCommunity.ipnsObj.publishToIpns(JSON.stringify(nameless));

                    const comment = await pkc.createComment({ cid: staticCommunity.commentCid });
                    const errorCodes: string[] = [];
                    comment.on("error", (error) => errorCodes.push((error as PKCError).code));
                    await comment.update();
                    try {
                        await vi.waitFor(() => expect(typeof comment.updatedAt).to.equal("number"), { timeout: 30_000, interval: 100 });
                        await vi.waitFor(() => expect(resolvedNames).to.include(communityName), { timeout: 30_000, interval: 100 });
                        expect(comment.communityPublicKey).to.equal(staticCommunity.communityAddress);
                        expect(errorCodes).to.not.include("ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY");
                        expect(errorCodes).to.not.include(MISMATCH_CODE);
                    } finally {
                        await comment.stop();
                    }
                } finally {
                    await pkc.destroy();
                    await staticCommunity.ipnsObj.pkc.destroy();
                    await otherCommunity.ipnsObj.pkc.destroy();
                }
            }
        );

        it(`getCommunity by a name the record does not claim rejects with the mismatch error and stops its updating instance`, async () => {
            // A community whose record never claimed the self-resolving name that points at its key
            const staticCommunity = await publishStaticCommunityWithPostInPages();
            const communityName = selfResolvingMockNameForAddress(staticCommunity.communityAddress);
            const pkc = await config.pkcInstancePromise();
            try {
                const startedAt = Date.now();
                const error = await pkc.getCommunity({ address: communityName }).then(
                    (): undefined => undefined,
                    (e: PKCError) => e
                );
                expect(error?.code).to.equal(MISMATCH_CODE);
                // Fails fast instead of waiting out the community-ipns timeout
                expect(Date.now() - startedAt).to.be.lessThan(pkc._timeouts["community-ipns"]);
                expect(pkc._updatingCommunities.size()).to.equal(0);
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });

        it(`getCommunity rejecting on a shared updating instance leaves that instance and its loader running`, async () => {
            const staticCommunity = await publishStaticCommunityWithPostInPages();
            const communityName = selfResolvingMockNameForAddress(staticCommunity.communityAddress);
            const pkc = await config.pkcInstancePromise();
            try {
                const byKey = await pkc.createCommunity({ address: staticCommunity.communityAddress });
                await byKey.update();
                await waitForUpdatedAt(byKey, staticCommunity.communityRecord.updatedAt);
                const sharedEntry = onlyUpdatingEntry(pkc);
                const countsBefore = listenerCounts(sharedEntry);

                // Matches the running instance by public key, so it mirrors it instead of loading its own
                const error = await pkc.getCommunity({ name: communityName, publicKey: staticCommunity.communityAddress }).then(
                    (): undefined => undefined,
                    (e: PKCError) => e
                );
                expect(error?.code).to.equal(MISMATCH_CODE);
                expect(onlyUpdatingEntry(pkc)).to.equal(sharedEntry);
                expect(listenerCounts(sharedEntry)).to.deep.equal(countsBefore);

                const newer = await publishNewerRecord({ staticCommunity, previous: staticCommunity.communityRecord, name: undefined });
                await waitForUpdatedAt(byKey, newer.updatedAt);
                expect(byKey.state).to.equal("updating");
                await byKey.stop();
                expect(pkc._updatingCommunities.size()).to.equal(0);
            } finally {
                await pkc.destroy();
                await staticCommunity.ipnsObj.pkc.destroy();
            }
        });
    });
});
