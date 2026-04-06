export enum STORAGE_KEYS {
    INTERNAL_SUBPLEBBIT, // InternalCommunityType
    PERSISTENT_DELETED_SUBPLEBBITS, // These are basically sub db files that we're unable to remove for some reason on windows
    LAST_IPNS_RECORD, // The last published IPNS record of the sub, updated everytime we publish a new one
    COMBINED_HASH_OF_PENDING_COMMENTS // hash of all cids of pending comments. This is used to decide to publish a new mod queue or not
}

// Configs for LRU storage
