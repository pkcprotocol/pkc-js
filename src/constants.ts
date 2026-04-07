export enum STORAGE_KEYS {
    INTERNAL_COMMUNITY, // InternalCommunityType
    PERSISTENT_DELETED_COMMUNITIES, // These are basically community db files that we're unable to remove for some reason on windows
    LAST_IPNS_RECORD, // The last published IPNS record of the community, updated everytime we publish a new one
    COMBINED_HASH_OF_PENDING_COMMENTS // hash of all cids of pending comments. This is used to decide to publish a new mod queue or not
}

// Configs for LRU storage
