export enum STORAGE_KEYS {
    INTERNAL_COMMUNITY, // InternalCommunityType
    PERSISTENT_DELETED_COMMUNITIES, // These are basically community db files that we're unable to remove for some reason on windows
    LAST_IPNS_RECORD, // The last published IPNS record of the community, updated everytime we publish a new one
    COMBINED_HASH_OF_PENDING_COMMENTS, // hash of all cids of pending comments. This is used to decide to publish a new mod queue or not
    EXPORTS, // CommunityExportRecord[] — backups of this community produced by community.export(); persisted so they survive process restart
    // The anchor record An -> Mn of a delegated community, signed by the owner's As and handed to us
    // through publishAnchorRecord. Deliberately NOT LAST_IPNS_RECORD: that one holds this node's own
    // minter record, a different name with an independent sequence space. See docs/protocol/delegated-ipns.md.
    ANCHOR_IPNS_RECORD,
    // Highest anchor sequence this node has ever accepted. Kept separately from the record above so a
    // rollback is refused even if the record itself is missing, and because kubo reports success for a
    // put it discards, which makes anti-rollback ours to enforce.
    HIGHEST_ACCEPTED_ANCHOR_SEQUENCE
}

// Configs for LRU storage

// How long a `nameResolved: false` verdict is trusted before it has to be earned again.
//
// `false` is an accusation ("this name is not that key") and nothing backs it: the persistent name cache
// stores successes only, so a negative verdict rests on evidence that is gone the moment it is made. The
// states that produce it are also the volatile ones. A domain with no TXT record yet, or one whose record is
// not a key, is what a correctly owned domain looks like five minutes before its owner finishes configuring
// it. Left permanent, the first viewer to look during that window would keep calling the author an impostor
// for the life of the process.
//
// A `true` is not treated this way: it is backed by a record in the persistent cache, and re-deriving it
// after expiry costs a disk read rather than a network resolve, so it rides that cache's `maxAge: 3600`.
//
// Used by both sides of the verdict: the author-side `nameResolvedCache` writes its `false` entries with
// this ttl, and the community side refuses to re-resolve a `false` `community.nameResolved` more often than
// this. Exported so tests can shorten it instead of waiting a minute. See issue #353.
export const NAME_RESOLVED_FALSE_TTL_MS = 60_000;

// How long an author-side `nameResolved: true` verdict is trusted. Matches the `maxAge: 3600` that
// `resolveAuthorNamesInBackground` passes to the persistent cache, so the in-memory verdict never claims
// more freshness than the layer underneath it and a domain transferred away stops reading as verified.
export const NAME_RESOLVED_TRUE_TTL_MS = 3600_000;
