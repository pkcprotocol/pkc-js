import { parseModQueuePageIpfs, parsePageIpfs } from "./util.js";
import type { GetPageParam, ModQueuePageIpfs, ModQueuePageTypeJson, PageIpfs, PageTypeJson, PostSortName, ReplySortName } from "./types.js";
import { verifyModQueuePage, verifyPage } from "../signer/signatures.js";
import {
    BasePagesClientsManager,
    SubplebbitPostsPagesClientsManager,
    RepliesPagesClientsManager,
    SubplebbitModQueueClientsManager
} from "./pages-client-manager.js";
import { PlebbitError } from "../plebbit-error.js";
import { deepMergeRuntimeFields, hideClassPrivateProps } from "../util.js";
import { Comment } from "../publications/comment/comment.js";
import { RemoteSubplebbit } from "../subplebbit/remote-subplebbit.js";
import { Plebbit } from "../plebbit/plebbit.js";
import { parsePageCidParams } from "./schema-util.js";
import { getAuthorDomainFromRuntime } from "../publications/publication-author.js";
import { sha256 } from "js-sha256";
import type { PageRuntimeFields } from "./util.js";

type BaseProps = {
    subplebbit: Pick<RemoteSubplebbit, "address" | "signature"> & {
        _getStopAbortSignal?: () => AbortSignal | undefined;
    };
    plebbit: Plebbit;
};

type PostsProps = Pick<PostsPages, "pages" | "pageCids"> & BaseProps & { subplebbit: RemoteSubplebbit };
type RepliesProps = Pick<RepliesPages, "pages" | "pageCids"> &
    BaseProps & {
        parentComment: Comment;
    };

type ModQueueProps = Pick<ModQueuePages, "pageCids" | "pages"> & BaseProps & { subplebbit: RemoteSubplebbit };

export class BasePages {
    pages!: PostsPages["pages"] | RepliesPages["pages"] | ModQueuePages["pages"];
    pageCids!: PostsPages["pageCids"] | RepliesPages["pageCids"] | ModQueuePages["pageCids"];
    clients!: BasePagesClientsManager["clients"];
    _clientsManager!: BasePagesClientsManager;
    _parentComment: Comment | undefined = undefined; // would be undefined if the comment is not initialized yet and we don't have comment.cid
    _subplebbit!: BaseProps["subplebbit"];

    constructor(props: PostsProps | RepliesProps | ModQueueProps) {
        this._initClientsManager(props.plebbit);
        this.updateProps(props);
        hideClassPrivateProps(this);
    }

    updateProps(props: Omit<PostsProps | RepliesProps | ModQueueProps, "plebbit">) {
        this.pages = props.pages;
        this.pageCids = props.pageCids;
        this._subplebbit = props.subplebbit;
        if (this.pageCids) {
            this._clientsManager.updatePageCidsToSortTypes(this.pageCids);
            this._clientsManager.updatePagesMaxSizeCache(Object.values(this.pageCids), 1024 * 1024);
        }
        if (this.pages) {
            for (const preloadedPage of Object.values(this.pages)) {
                if (preloadedPage?.nextCid) this._clientsManager.updatePagesMaxSizeCache([preloadedPage.nextCid], 1024 * 1024);
                if (preloadedPage) this._applyNameResolvedCacheToPage(preloadedPage);
            }
        }
    }

    private _applyNameResolvedCacheToPage(page: PageTypeJson | ModQueuePageTypeJson) {
        const cache = this._clientsManager._plebbit._memCaches.nameResolvedCache;
        for (const comment of page.comments) {
            const domain = getAuthorDomainFromRuntime(comment.author);
            if (!domain) continue;
            const cacheKey = sha256(domain + comment.signature.publicKey);
            const cached = cache.get(cacheKey);
            if (typeof cached === "boolean") comment.author.nameResolved = cached;
        }
    }

    protected _initClientsManager(plebbit: Plebbit) {
        throw Error(`This function should be overridden`);
    }

    resetPages() {
        // Called when the sub changes address and needs to remove all the comments with the old subplebbit address
        this.pageCids = {};
        this.pages = {};
    }

    async _validatePage(pageIpfs: PageIpfs | ModQueuePageIpfs, pageCid?: string) {
        throw Error("should be implemented");
    }

    async _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{ page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields }> {
        const { page: pageIpfs, runtimeFields } = await this._clientsManager.fetchPage(opts.pageCid, opts.pageMaxSize);
        if (!this._clientsManager._plebbit._plebbitRpcClient && this._clientsManager._plebbit.validatePages)
            await this._validatePage(pageIpfs, opts.pageCid);

        return { page: pageIpfs, runtimeFields };
    }

    _parseRawPageIpfs(pageIpfs: PageIpfs | ModQueuePageIpfs): ModQueuePageTypeJson | PageTypeJson {
        throw Error("should be implemented");
    }

    async getPage(pageCid: GetPageParam): Promise<PageTypeJson | ModQueuePageTypeJson> {
        if (!this._subplebbit?.address) throw Error("Subplebbit address needs to be defined under page");
        const parsedArgs = parsePageCidParams(pageCid);

        const { page: pageIpfs, runtimeFields } = await this._fetchAndVerifyPage({ pageCid: parsedArgs.cid });
        const parsed = this._parseRawPageIpfs(pageIpfs);
        this._applyNameResolvedCacheToPage(parsed);
        if (runtimeFields) deepMergeRuntimeFields(parsed, runtimeFields);
        return parsed;
    }

    // method below will be present in both subplebbit.posts and comment.replies
    async validatePage(page: PageIpfs | PageTypeJson) {
        if (this._clientsManager._plebbit.validatePages)
            throw Error("This function is used for manual verification and you need to have plebbit.validatePages=false");
        const pageIpfs = <PageIpfs>{ comments: page.comments.map((comment) => ("comment" in comment ? comment : comment.raw)) };

        await this._validatePage(pageIpfs);
    }

    _stop() {}
}

export class RepliesPages extends BasePages {
    override pages!: Partial<Record<ReplySortName, PageTypeJson>>;

    override pageCids!: Record<ReplySortName, string>;

    override clients!: RepliesPagesClientsManager["clients"];

    override _clientsManager!: RepliesPagesClientsManager;
    override _parentComment: Comment; // is always defined but we need to check its field if they're initialized or not

    constructor(props: RepliesProps) {
        super(props);
        this._parentComment = props.parentComment;
        hideClassPrivateProps(this);
    }

    override updateProps(props: Omit<RepliesProps, "plebbit" | "parentComment">) {
        super.updateProps(props);
    }

    protected override _initClientsManager(plebbit: Plebbit): void {
        this._clientsManager = new RepliesPagesClientsManager({ plebbit, pages: this });
        this.clients = this._clientsManager.clients;
    }

    override async _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{ page: PageIpfs; runtimeFields?: PageRuntimeFields }> {
        const result = await super._fetchAndVerifyPage(opts);
        return { page: result.page as PageIpfs, runtimeFields: result.runtimeFields };
    }

    override _parseRawPageIpfs(pageIpfs: PageIpfs): PageTypeJson {
        return parsePageIpfs(pageIpfs);
    }

    override async getPage(args: GetPageParam): Promise<PageTypeJson> {
        if (!this._parentComment?.cid)
            throw new PlebbitError("ERR_USER_ATTEMPTS_TO_GET_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_CID", {
                getPageArgs: args,
                parentComment: this._parentComment
            });

        if (typeof this._parentComment?.depth !== "number")
            throw new PlebbitError("ERR_USER_ATTEMPTS_TO_GET_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_DEPTH", {
                parentComment: this._parentComment,
                getPageArgs: args
            });

        if (!this._parentComment?.postCid)
            throw new PlebbitError("ERR_USER_ATTEMPTS_TO_GET_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_POST_CID", {
                getPageArgs: args,
                parentComment: this._parentComment
            });

        // we need to make all updating comment instances do the getPage call to cache _loadedUniqueCommentFromGetPage in a centralized instance

        return <PageTypeJson>await super.getPage(args);
    }

    override async _validatePage(pageIpfs: PageIpfs, pageCid?: string) {
        if (!this._parentComment?.cid)
            throw new PlebbitError("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_CID", {
                pageIpfs,
                pageCid,
                parentComment: this._parentComment
            });

        if (typeof this._parentComment?.depth !== "number")
            throw new PlebbitError("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_DEPTH", {
                pageIpfs,
                parentComment: this._parentComment,
                pageCid
            });

        if (!this._parentComment?.postCid)
            throw new PlebbitError("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_POST_CID", {
                pageIpfs,
                pageCid,
                parentComment: this._parentComment
            });

        if (pageIpfs.comments.length === 0) return;
        const baseDepth = pageIpfs.comments[0].comment?.depth;
        const isUniformDepth = pageIpfs.comments.every((comment) => comment.comment.depth === baseDepth);
        const pageSortName = Object.entries(this.pageCids).find(([_, pageCid]) => pageCid === pageCid)?.[0];
        const verificationOpts = {
            pageCid,
            pageSortName,
            page: pageIpfs,
            resolveAuthorNames: this._clientsManager._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager,
            subplebbit: this._subplebbit,
            parentComment: isUniformDepth ? this._parentComment : { postCid: this._parentComment.postCid }, // if it's a flat page, we don't need to verify the parent comment. Only the post

            validatePages: this._clientsManager._plebbit.validatePages,
            validateUpdateSignature: false, // no need because we verified that page cid matches its content
            abortSignal: this._parentComment._getStopAbortSignal()
        };
        const signatureValidity = await verifyPage(verificationOpts);
        if (!signatureValidity.valid)
            throw new PlebbitError("ERR_REPLIES_PAGE_IS_INVALID", {
                signatureValidity,
                verificationOpts
            });
    }
}

export class PostsPages extends BasePages {
    override pages!: Partial<Record<PostSortName, PageTypeJson>>;

    override pageCids!: Record<PostSortName, string>;

    override clients!: SubplebbitPostsPagesClientsManager["clients"];

    override _clientsManager!: SubplebbitPostsPagesClientsManager;
    override _parentComment: undefined = undefined; // would be undefined because we don't have a parent comment for posts
    override _subplebbit!: RemoteSubplebbit;

    constructor(props: PostsProps) {
        super(props);
    }

    override updateProps(props: Omit<PostsProps, "plebbit">) {
        super.updateProps(props);
    }

    protected override _initClientsManager(plebbit: Plebbit): void {
        this._clientsManager = new SubplebbitPostsPagesClientsManager({ plebbit, pages: this });
        this.clients = this._clientsManager.clients;
    }

    override async _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{ page: PageIpfs; runtimeFields?: PageRuntimeFields }> {
        const result = await super._fetchAndVerifyPage(opts);
        return { page: result.page as PageIpfs, runtimeFields: result.runtimeFields };
    }

    override _parseRawPageIpfs(pageIpfs: PageIpfs): PageTypeJson {
        return parsePageIpfs(pageIpfs);
    }

    override async getPage(getPageArgs: GetPageParam): Promise<PageTypeJson> {
        // we need to make all updating subplebbit instances do the getPage call to cache _loadedUniqueCommentFromGetPage

        return <PageTypeJson>await super.getPage(getPageArgs);
    }

    override async _validatePage(pageIpfs: PageIpfs, pageCid?: string) {
        if (pageIpfs.comments.length === 0) return;
        const pageSortName = Object.entries(this.pageCids).find(([_, pageCid]) => pageCid === pageCid)?.[0];
        const verificationOpts = {
            pageCid,
            pageSortName,
            page: pageIpfs,
            resolveAuthorNames: this._clientsManager._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager,
            subplebbit: this._subplebbit,
            parentComment: { cid: undefined, postCid: undefined, depth: -1 },

            validatePages: this._clientsManager._plebbit.validatePages,
            validateUpdateSignature: false, // no need because we verified that page cid matches its content
            abortSignal: this._subplebbit._getStopAbortSignal?.()
        };
        const signatureValidity = await verifyPage(verificationOpts);
        if (!signatureValidity.valid)
            throw new PlebbitError("ERR_POSTS_PAGE_IS_INVALID", {
                signatureValidity,
                verificationOpts
            });
    }
}

type ModQueuePageCids = Record<string, string>; // cid string, we assume pendingApproval is under pageCids

export class ModQueuePages extends BasePages {
    override pages!: Partial<Record<string, ModQueuePageTypeJson>>;
    override pageCids!: ModQueuePageCids;
    override _parentComment = undefined;

    constructor(props: ModQueueProps) {
        super(props);
    }

    override resetPages(): void {
        this.pageCids = {};
        this.pages = {};
    }

    protected override _initClientsManager(plebbit: Plebbit): void {
        this._clientsManager = new SubplebbitModQueueClientsManager({ plebbit, pages: this });
        this.clients = this._clientsManager.clients;
    }

    override async _fetchAndVerifyPage(opts: {
        pageCid: string;
        pageMaxSize?: number;
    }): Promise<{ page: ModQueuePageIpfs; runtimeFields?: PageRuntimeFields }> {
        const result = await super._fetchAndVerifyPage(opts);
        return { page: result.page as ModQueuePageIpfs, runtimeFields: result.runtimeFields };
    }

    override _parseRawPageIpfs(pageIpfs: ModQueuePageIpfs): ModQueuePageTypeJson {
        return parseModQueuePageIpfs(pageIpfs);
    }

    override async getPage(getPageArgs: GetPageParam): Promise<ModQueuePageTypeJson> {
        return <ModQueuePageTypeJson>await super.getPage(getPageArgs);
    }

    override async _validatePage(pageIpfs: ModQueuePageIpfs, pageCid?: string) {
        if (pageIpfs.comments.length === 0) return;
        const pageSortName = Object.entries(this.pageCids).find(([_, pageCid]) => pageCid === pageCid)?.[0];
        const verificationOpts = {
            pageCid,
            pageSortName,
            page: pageIpfs,
            resolveAuthorNames: this._clientsManager._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager,
            subplebbit: this._subplebbit,
            parentComment: { cid: undefined, postCid: undefined, depth: -1 },

            validatePages: this._clientsManager._plebbit.validatePages,
            validateUpdateSignature: false, // no need because we verified that page cid matches its content
            abortSignal: this._subplebbit._getStopAbortSignal?.()
        };
        const signatureValidity = await verifyModQueuePage(verificationOpts);
        if (!signatureValidity.valid)
            throw new PlebbitError("ERR_MOD_QUEUE_PAGE_IS_INVALID", {
                signatureValidity,
                verificationOpts
            });
    }
}
