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
