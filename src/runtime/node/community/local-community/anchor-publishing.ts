import Logger from "../../../../logger.js";
import { peerIdFromString } from "@libp2p/peer-id";
import { STORAGE_KEYS } from "../../../../constants.js";
import { PKCError } from "../../../../pkc-error.js";
import { getIpnsRecordInLocalKuboNode } from "../../../../util.js";
import type { LocalCommunity } from "../local-community.js";
import type { AnchorPublishPreparation, PublishedAnchorRecord } from "../../../../community/types.js";

// Sequences skipped are free, and a stale answer that lands too LOW is unrecoverable: the owner signs
// a record that can never beat one already out there, with no way to tell. So every answer clears the
// highest sequence we know of by a margin rather than by one.
const ANCHOR_SEQUENCE_MARGIN = 5n;

// How long to wait for the anchor's own record to come back from the network. This is a plain IPNS
// resolution through the local kubo node, not a chain walk.
const ANCHOR_LOOKUP_TIMEOUT_MS = 30_000;

function assertDelegated(community: LocalCommunity): { publicKey: string } {
    if (!community.anchor)
        throw new PKCError("ERR_COMMUNITY_IS_NOT_DELEGATED", { address: community.address, signerAddress: community.signer?.address });
    return community.anchor;
}

// The bytes as handed to us, kept verbatim: re-providing means putting the SAME signed record again,
// and we cannot re-sign it.
export function getPersistedAnchorRecordBytes(community: LocalCommunity): Uint8Array | undefined {
    const stored = community._dbHandler.keyvGet<Record<string, number> | Uint8Array>(STORAGE_KEYS[STORAGE_KEYS.ANCHOR_IPNS_RECORD]);
    if (!stored) return undefined;
    return stored instanceof Uint8Array ? stored : new Uint8Array(Object.values(stored));
}

export function getHighestAcceptedAnchorSequence(community: LocalCommunity): bigint | undefined {
    const stored = community._dbHandler.keyvGet<string>(STORAGE_KEYS[STORAGE_KEYS.HIGHEST_ACCEPTED_ANCHOR_SEQUENCE]);
    // Stored as a string: keyv round-trips through JSON, which has no bigint.
    return typeof stored === "string" ? BigInt(stored) : undefined;
}

// Looks the anchor record up on the network through the local kubo node. Returns undefined when the
// name does not resolve, which kubo reports the same way whether the record has never existed or the
// routers merely failed us — the caller must never turn that ambiguity into a sequence of 0.
async function lookupAnchorRecordOnNetwork(community: LocalCommunity, anchorName: string) {
    const log = Logger("pkc-js:local-community:prepareAnchorPublish");
    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();
    try {
        return await Promise.race([
            getIpnsRecordInLocalKuboNode(kuboRpcClient, anchorName),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ANCHOR_LOOKUP_TIMEOUT_MS))
        ]);
    } catch (e) {
        log.trace(`Anchor (${anchorName}) did not resolve while preparing a publish`, e);
        return undefined;
    }
}

// Answers "what sequence should I sign next?" for the owner, who is offline and cannot know. Only
// needed to rotate or re-publish: a community's first anchor record uses the nextSequence of 0 that
// createCommunity already returned. See docs/protocol/delegated-ipns.md.
export async function prepareAnchorPublish(community: LocalCommunity): Promise<AnchorPublishPreparation> {
    const log = Logger("pkc-js:local-community:prepareAnchorPublish");
    const anchor = assertDelegated(community);
    await community._dbHandler.initDbIfNeeded();

    const persistedSequence = getHighestAcceptedAnchorSequence(community);
    const networkRecord = await lookupAnchorRecordOnNetwork(community, anchor.publicKey);
    const networkSequence = networkRecord ? BigInt(networkRecord.sequence) : undefined;

    // Nothing anywhere knows a sequence. This is either a genuinely fresh anchor or a lookup that came
    // back empty for an anchor that does have history, and the two are indistinguishable here — kubo
    // reports both as "did not resolve". Answering 0 on the second reading hands the owner a correctly
    // signed record that loses to its own predecessor forever, so refuse instead. A first publish does
    // not need this method at all.
    if (persistedSequence === undefined && networkSequence === undefined)
        throw new PKCError("ERR_UNABLE_TO_DETERMINE_ANCHOR_SEQUENCE", {
            address: community.address,
            anchorPublicKey: anchor.publicKey,
            reason: "This node has never accepted an anchor record for this community and /ipns/<anchor> did not resolve. If this anchor has never been published, sign sequence 0 (the nextSequence createCommunity returned); otherwise retry once the anchor resolves."
        });

    const highestKnown = [persistedSequence, networkSequence].reduce<bigint>(
        (max, seq) => (seq !== undefined && seq > max ? seq : max),
        0n
    );
    const nextSequence = highestKnown + ANCHOR_SEQUENCE_MARGIN;
    log(
        `Prepared anchor publish for community (${community.address}): persisted=${persistedSequence}, network=${networkSequence}, next=${nextSequence}`
    );

    return {
        nextSequence: nextSequence.toString(),
        currentAnchorRecordSequence: highestKnown.toString(),
        hasPersistedAnchorRecord: persistedSequence !== undefined
    };
}

// Pushes an already-signed record out through kubo. name.publish cannot do this: it signs with a key
// from the node's keystore, and the whole point is that we do not have As. routing.put takes the bytes
// as they are, forwards them to the delegated HTTP routers, and subscribes this node to the anchor's
// ipns-over-pubsub topic so it serves the record to peers.
async function putAnchorRecordThroughKubo(community: LocalCommunity, anchorName: string, recordBytes: Uint8Array) {
    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();
    // allowOffline so a node with no reachable router still stores and serves the record locally rather
    // than failing the owner's publish outright.
    for await (const _event of kuboRpcClient._client.routing.put(`/ipns/${anchorName}`, recordBytes, { allowOffline: true }));
}

// Serializes publishes per community address, keyed by address rather than by instance because the same
// community is routinely represented by more than one LocalCommunity object in a process (the RPC server
// creates its own). The window this closes: read the high-water mark, then await the kubo put and two
// keyvSets before persisting it. Two concurrent publishes both clear the check, and last-write-wins can
// persist the LOWER sequence, after which a record in between passes our check, gets silently dropped by
// kubo (which answers 200 to a rollback put, the very reason this check is ours), and we report success
// for a publish that never happened.
//
// In-process only. Two processes publishing anchor records for the same community concurrently would
// still race; that is already true of the community DB as a whole, which lockCommunityStart guards
// against rather than merges.
const anchorPublishQueues = new Map<string, Promise<void>>();

function serializePerCommunityAddress<T>(address: string, task: () => Promise<T>): Promise<T> {
    const previous = anchorPublishQueues.get(address) ?? Promise.resolve();
    const run = previous.then(task);
    // The queue itself must never reject, or one failed publish would fail every publish behind it.
    // The caller still sees the rejection through `run`.
    const settled = run.then(
        () => {},
        () => {}
    );
    anchorPublishQueues.set(address, settled);
    // Drop the entry once nothing is queued behind it, so a long-lived process does not accumulate one
    // resolved promise per community it has ever published an anchor record for.
    settled.then(() => {
        if (anchorPublishQueues.get(address) === settled) anchorPublishQueues.delete(address);
    });
    return run;
}

// Verifies a record the owner signed with As and, only if it is one this node may serve, publishes it
// and remembers it. The node can refuse the binding but can never forge or replace it.
export async function publishAnchorRecord(community: LocalCommunity, recordBytes: Uint8Array): Promise<PublishedAnchorRecord> {
    return serializePerCommunityAddress(community.address, () => publishAnchorRecordSerialized(community, recordBytes));
}

async function publishAnchorRecordSerialized(community: LocalCommunity, recordBytes: Uint8Array): Promise<PublishedAnchorRecord> {
    const log = Logger("pkc-js:local-community:publishAnchorRecord");
    const anchor = assertDelegated(community);
    await community._dbHandler.initDbIfNeeded();

    const { multihashToIPNSRoutingKey, unmarshalIPNSRecord } = await import("ipns");
    const { ipnsValidator } = await import("ipns/validator");

    const bytes = recordBytes instanceof Uint8Array ? recordBytes : new Uint8Array(Object.values(recordBytes));

    // Signed by An, and well-formed. ipnsValidator checks the signature against the key the anchor's
    // routing key commits to, so a record signed by any other key fails here.
    try {
        await ipnsValidator(multihashToIPNSRoutingKey(peerIdFromString(anchor.publicKey).toMultihash()), bytes);
    } catch (e) {
        throw new PKCError("ERR_ANCHOR_IPNS_RECORD_IS_INVALID", {
            address: community.address,
            anchorPublicKey: anchor.publicKey,
            validationError: e
        });
    }

    const record = unmarshalIPNSRecord(bytes);

    // Points at OUR minter. A record binding the anchor to someone else's Mn is perfectly valid, it is
    // just not ours to serve, and serving it would advertise a community this node does not publish.
    const expectedValue = `/ipns/${community.signer.address}`;
    if (record.value !== expectedValue)
        throw new PKCError("ERR_ANCHOR_IPNS_RECORD_POINTS_TO_DIFFERENT_MINTER", {
            address: community.address,
            anchorPublicKey: anchor.publicKey,
            expectedValue,
            recordValue: record.value
        });

    // Strictly greater. kubo answers 200 to a put it silently discards for being older, so it cannot be
    // relied on to report a rollback — the check has to live here, and equal is refused too: with the
    // anchor lifetime the validity tiebreak is also a tie, leaving the winner undefined.
    const sequence = BigInt(record.sequence);
    const highestAccepted = getHighestAcceptedAnchorSequence(community);
    if (highestAccepted !== undefined && sequence <= highestAccepted)
        throw new PKCError("ERR_ANCHOR_IPNS_RECORD_SEQUENCE_IS_NOT_GREATER", {
            address: community.address,
            anchorPublicKey: anchor.publicKey,
            recordSequence: sequence.toString(),
            highestAcceptedSequence: highestAccepted.toString()
        });

    await putAnchorRecordThroughKubo(community, anchor.publicKey, bytes);

    await community._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.ANCHOR_IPNS_RECORD], bytes);
    await community._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.HIGHEST_ACCEPTED_ANCHOR_SEQUENCE], sequence.toString());
    community.anchorRecordSequence = sequence.toString();

    log(`Published anchor record for community (${community.address}) at sequence ${sequence}, pointing at ${record.value}`);

    return { sequence: sequence.toString(), value: record.value, anchorPublicKey: anchor.publicKey };
}

// Re-puts the record we already hold. Two reasons this is not optional: the record's own routers expire
// it, and a restarted kubo keeps the record in its datastore but drops the ipns-over-pubsub
// subscription, so it stops answering for the anchor until something puts again. Hence this runs at
// start() as well as on the publish loop, not on a timer alone.
export async function reprovideAnchorRecordIfNeeded(community: LocalCommunity): Promise<boolean> {
    const log = Logger("pkc-js:local-community:reprovideAnchorRecord");
    if (!community.anchor) return false;
    const bytes = getPersistedAnchorRecordBytes(community);
    if (!bytes) return false;

    await putAnchorRecordThroughKubo(community, community.anchor.publicKey, bytes);
    community._lastAnchorRecordReprovideAt = Date.now();
    log.trace(`Re-provided anchor record of community (${community.address})`);
    return true;
}

// Throttle for the publish-loop call site: the record is long-lived, so this is about keeping routers
// and the pubsub subscription warm, not about freshness.
export const ANCHOR_REPROVIDE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function reprovideAnchorRecordIfDue(community: LocalCommunity): Promise<void> {
    if (!community.anchor) return;
    const lastAt = community._lastAnchorRecordReprovideAt;
    if (typeof lastAt === "number" && Date.now() - lastAt < ANCHOR_REPROVIDE_INTERVAL_MS) return;
    await reprovideAnchorRecordIfNeeded(community);
}
