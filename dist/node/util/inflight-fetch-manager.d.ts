export declare class InflightFetchManager {
    private _inflightFetches;
    private _getKey;
    withKey<T>(key: string, fetcher: () => Promise<T>): Promise<T>;
    withResource<T>(resourceType: string, identifier: string, fetcher: () => Promise<T>): Promise<T>;
}
export declare const InflightResourceTypes: {
    readonly COMMUNITY_IPNS: "community-ipns";
    readonly COMMENT_IPFS: "comment-ipfs";
};
export type InflightResourceType = (typeof InflightResourceTypes)[keyof typeof InflightResourceTypes];
