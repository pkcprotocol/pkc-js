import {
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
