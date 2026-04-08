export declare enum STORAGE_KEYS {
    INTERNAL_COMMUNITY = 0,// InternalCommunityType
    PERSISTENT_DELETED_COMMUNITIES = 1,// These are basically community db files that we're unable to remove for some reason on windows
    LAST_IPNS_RECORD = 2,// The last published IPNS record of the community, updated everytime we publish a new one
    COMBINED_HASH_OF_PENDING_COMMENTS = 3
}
