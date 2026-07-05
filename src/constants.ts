export enum STORAGE_KEYS {
    INTERNAL_COMMUNITY, // InternalCommunityType
    PERSISTENT_DELETED_COMMUNITIES, // These are basically community db files that we're unable to remove for some reason on windows
    LAST_IPNS_RECORD, // The last published IPNS record of the community, updated everytime we publish a new one
    COMBINED_HASH_OF_PENDING_COMMENTS, // hash of all cids of pending comments. This is used to decide to publish a new mod queue or not
    EXPORTS // CommunityExportRecord[] — backups of this community produced by community.export(); persisted so they survive process restart
}

// Max byte size of a CommentUpdate file. Lives here (a dependency-free constants module) rather than
// in comment-client-manager.ts so that importers which only need the number — e.g. runtime/node/util.ts
// — don't drag in the comment-client-manager graph (-> signer/signatures, signer/util -> @libp2p/peer-id).
// See issue #120 (slim ./client import).
export const MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE = 1024 * 1024;

// Configs for LRU storage
