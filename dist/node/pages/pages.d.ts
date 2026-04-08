import type { GetPageParam, ModQueuePageIpfs, ModQueuePageTypeJson, PageIpfs, PageTypeJson, PostSortName, ReplySortName } from "./types.js";
import { BasePagesClientsManager, CommunityPostsPagesClientsManager, RepliesPagesClientsManager } from "./pages-client-manager.js";
import { Comment } from "../publications/comment/comment.js";
import { RemoteCommunity } from "../community/remote-community.js";
import { PKC } from "../pkc/pkc.js";
import type { PageRuntimeFields } from "./util.js";
type BaseProps = {
    community: Pick<RemoteCommunity, "address" | "signature"> & {
        _getStopAbortSignal?: () => AbortSignal | undefined;
    };
    pkc: PKC;
};
type PostsProps = Pick<PostsPages, "pages" | "pageCids"> & BaseProps & {
    community: RemoteCommunity;
};
type RepliesProps = Pick<RepliesPages, "pages" | "pageCids"> & BaseProps & {
    parentComment: Comment;
};
type ModQueueProps = Pick<ModQueuePages, "pageCids" | "pages"> & BaseProps & {
    community: RemoteCommunity;
};
export declare class BasePages {
    pages: PostsPages["pages"] | RepliesPages["pages"] | ModQueuePages["pages"];
    pageCids: PostsPages["pageCids"] | RepliesPages["pageCids"] | ModQueuePages["pageCids"];
    clients: BasePagesClientsManager["clients"];
    _clientsManager: BasePagesClientsManager;
    _parentComment: Comment | undefined;
    _community: BaseProps["community"];
    constructor(props: PostsProps | RepliesProps | ModQueueProps);
    updateProps(props: Omit<PostsProps | RepliesProps | ModQueueProps, "pkc">): void;
    _applyNameResolvedCacheToPage(page: PageTypeJson | ModQueuePageTypeJson): void;
    protected _initClientsManager(pkc: PKC): void;
    resetPages(): void;
    _validatePage(pageIpfs: PageIpfs | ModQueuePageIpfs, pageCid?: string): Promise<void>;
    _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{
        page: PageIpfs | ModQueuePageIpfs;
        runtimeFields?: PageRuntimeFields;
    }>;
    _parseRawPageIpfs(pageIpfs: PageIpfs | ModQueuePageIpfs): ModQueuePageTypeJson | PageTypeJson;
    getPage(pageCid: GetPageParam): Promise<PageTypeJson | ModQueuePageTypeJson>;
    validatePage(page: PageIpfs | PageTypeJson): Promise<void>;
    _stop(): void;
}
export declare class RepliesPages extends BasePages {
    pages: Partial<Record<ReplySortName, PageTypeJson>>;
    pageCids: Record<ReplySortName, string>;
    clients: RepliesPagesClientsManager["clients"];
    _clientsManager: RepliesPagesClientsManager;
    _parentComment: Comment;
    constructor(props: RepliesProps);
    updateProps(props: Omit<RepliesProps, "pkc" | "parentComment">): void;
    protected _initClientsManager(pkc: PKC): void;
    _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{
        page: PageIpfs;
        runtimeFields?: PageRuntimeFields;
    }>;
    _parseRawPageIpfs(pageIpfs: PageIpfs): PageTypeJson;
    getPage(args: GetPageParam): Promise<PageTypeJson>;
    _validatePage(pageIpfs: PageIpfs, pageCid?: string): Promise<void>;
}
export declare class PostsPages extends BasePages {
    pages: Partial<Record<PostSortName, PageTypeJson>>;
    pageCids: Record<PostSortName, string>;
    clients: CommunityPostsPagesClientsManager["clients"];
    _clientsManager: CommunityPostsPagesClientsManager;
    _parentComment: undefined;
    _community: RemoteCommunity;
    constructor(props: PostsProps);
    updateProps(props: Omit<PostsProps, "pkc">): void;
    protected _initClientsManager(pkc: PKC): void;
    _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{
        page: PageIpfs;
        runtimeFields?: PageRuntimeFields;
    }>;
    _parseRawPageIpfs(pageIpfs: PageIpfs): PageTypeJson;
    getPage(getPageArgs: GetPageParam): Promise<PageTypeJson>;
    _validatePage(pageIpfs: PageIpfs, pageCid?: string): Promise<void>;
}
type ModQueuePageCids = Record<string, string>;
export declare class ModQueuePages extends BasePages {
    pages: Partial<Record<string, ModQueuePageTypeJson>>;
    pageCids: ModQueuePageCids;
    _parentComment: undefined;
    constructor(props: ModQueueProps);
    resetPages(): void;
    protected _initClientsManager(pkc: PKC): void;
    _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{
        page: ModQueuePageIpfs;
        runtimeFields?: PageRuntimeFields;
    }>;
    _parseRawPageIpfs(pageIpfs: ModQueuePageIpfs): ModQueuePageTypeJson;
    getPage(getPageArgs: GetPageParam): Promise<ModQueuePageTypeJson>;
    _validatePage(pageIpfs: ModQueuePageIpfs, pageCid?: string): Promise<void>;
}
export {};
