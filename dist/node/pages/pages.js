import { parseModQueuePageIpfs, parsePageIpfs } from "./util.js";
import { verifyModQueuePage, verifyPage } from "../signer/signatures.js";
import { CommunityPostsPagesClientsManager, RepliesPagesClientsManager, CommunityModQueueClientsManager } from "./pages-client-manager.js";
import { PKCError } from "../pkc-error.js";
import { deepMergeRuntimeFields, hideClassPrivateProps } from "../util.js";
import { parsePageCidParams } from "./schema-util.js";
import { getAuthorDomainFromRuntime } from "../publications/publication-author.js";
import { sha256 } from "js-sha256";
export class BasePages {
    constructor(props) {
        this._parentComment = undefined; // would be undefined if the comment is not initialized yet and we don't have comment.cid
        this._initClientsManager(props.pkc);
        this.updateProps(props);
        hideClassPrivateProps(this);
    }
    updateProps(props) {
        this.pages = props.pages;
        this.pageCids = props.pageCids;
        this._community = props.community;
        if (this.pageCids) {
            this._clientsManager.updatePageCidsToSortTypes(this.pageCids);
            this._clientsManager.updatePagesMaxSizeCache(Object.values(this.pageCids), 1024 * 1024);
        }
        if (this.pages) {
            for (const preloadedPage of Object.values(this.pages)) {
                if (preloadedPage?.nextCid)
                    this._clientsManager.updatePagesMaxSizeCache([preloadedPage.nextCid], 1024 * 1024);
                if (preloadedPage)
                    this._applyNameResolvedCacheToPage(preloadedPage);
            }
        }
    }
    _applyNameResolvedCacheToPage(page) {
        const cache = this._clientsManager._pkc._memCaches.nameResolvedCache;
        for (const comment of page.comments) {
            const domain = getAuthorDomainFromRuntime(comment.author);
            if (!domain)
                continue;
            const cacheKey = sha256(domain + comment.signature.publicKey);
            const cached = cache.get(cacheKey);
            if (typeof cached === "boolean")
                comment.author.nameResolved = cached;
        }
    }
    _initClientsManager(pkc) {
        throw Error(`This function should be overridden`);
    }
    resetPages() {
        // Called when the community changes address and needs to remove all the comments with the old community address
        this.pageCids = {};
        this.pages = {};
    }
    async _validatePage(pageIpfs, pageCid) {
        throw Error("should be implemented");
    }
    async _fetchAndVerifyPage(opts) {
        const { page: pageIpfs, runtimeFields } = await this._clientsManager.fetchPage(opts.pageCid, opts.pageMaxSize);
        if (!this._clientsManager._pkc._pkcRpcClient && this._clientsManager._pkc.validatePages)
            await this._validatePage(pageIpfs, opts.pageCid);
        return { page: pageIpfs, runtimeFields };
    }
    _parseRawPageIpfs(pageIpfs) {
        throw Error("should be implemented");
    }
    async getPage(pageCid) {
        if (!this._community?.address)
            throw Error("Community address needs to be defined under page");
        const parsedArgs = parsePageCidParams(pageCid);
        const { page: pageIpfs, runtimeFields } = await this._fetchAndVerifyPage({ pageCid: parsedArgs.cid });
        const parsed = this._parseRawPageIpfs(pageIpfs);
        this._applyNameResolvedCacheToPage(parsed);
        if (runtimeFields)
            deepMergeRuntimeFields(parsed, runtimeFields);
        return parsed;
    }
    // method below will be present in both community.posts and comment.replies
    async validatePage(page) {
        if (this._clientsManager._pkc.validatePages)
            throw Error("This function is used for manual verification and you need to have pkc.validatePages=false");
        const pageIpfs = { comments: page.comments.map((comment) => ("comment" in comment ? comment : comment.raw)) };
        await this._validatePage(pageIpfs);
    }
    _stop() { }
}
export class RepliesPages extends BasePages {
    constructor(props) {
        super(props);
        this._parentComment = props.parentComment;
        hideClassPrivateProps(this);
    }
    updateProps(props) {
        super.updateProps(props);
    }
    _initClientsManager(pkc) {
        this._clientsManager = new RepliesPagesClientsManager({ pkc, pages: this });
        this.clients = this._clientsManager.clients;
    }
    async _fetchAndVerifyPage(opts) {
        const result = await super._fetchAndVerifyPage(opts);
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
    _parseRawPageIpfs(pageIpfs) {
        return parsePageIpfs(pageIpfs);
    }
    async getPage(args) {
        if (!this._parentComment?.cid)
            throw new PKCError("ERR_USER_ATTEMPTS_TO_GET_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_CID", {
                getPageArgs: args,
                parentComment: this._parentComment
            });
        if (typeof this._parentComment?.depth !== "number")
            throw new PKCError("ERR_USER_ATTEMPTS_TO_GET_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_DEPTH", {
                parentComment: this._parentComment,
                getPageArgs: args
            });
        if (!this._parentComment?.postCid)
            throw new PKCError("ERR_USER_ATTEMPTS_TO_GET_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_POST_CID", {
                getPageArgs: args,
                parentComment: this._parentComment
            });
        // we need to make all updating comment instances do the getPage call to cache _loadedUniqueCommentFromGetPage in a centralized instance
        return await super.getPage(args);
    }
    async _validatePage(pageIpfs, pageCid) {
        if (!this._parentComment?.cid)
            throw new PKCError("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_CID", {
                pageIpfs,
                pageCid,
                parentComment: this._parentComment
            });
        if (typeof this._parentComment?.depth !== "number")
            throw new PKCError("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_DEPTH", {
                pageIpfs,
                parentComment: this._parentComment,
                pageCid
            });
        if (!this._parentComment?.postCid)
            throw new PKCError("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_POST_CID", {
                pageIpfs,
                pageCid,
                parentComment: this._parentComment
            });
        if (pageIpfs.comments.length === 0)
            return;
        const baseDepth = pageIpfs.comments[0].comment?.depth;
        const isUniformDepth = pageIpfs.comments.every((comment) => comment.comment.depth === baseDepth);
        const pageSortName = Object.entries(this.pageCids).find(([_, pageCid]) => pageCid === pageCid)?.[0];
        const verificationOpts = {
            pageCid,
            pageSortName,
            page: pageIpfs,
            resolveAuthorNames: this._clientsManager._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager,
            community: this._community,
            parentComment: isUniformDepth ? this._parentComment : { postCid: this._parentComment.postCid }, // if it's a flat page, we don't need to verify the parent comment. Only the post
            validatePages: this._clientsManager._pkc.validatePages,
            validateUpdateSignature: false, // no need because we verified that page cid matches its content
            abortSignal: this._parentComment._getStopAbortSignal()
        };
        const signatureValidity = await verifyPage(verificationOpts);
        if (!signatureValidity.valid)
            throw new PKCError("ERR_REPLIES_PAGE_IS_INVALID", {
                signatureValidity,
                verificationOpts
            });
    }
}
export class PostsPages extends BasePages {
    constructor(props) {
        super(props);
        this._parentComment = undefined; // would be undefined because we don't have a parent comment for posts
    }
    updateProps(props) {
        super.updateProps(props);
    }
    _initClientsManager(pkc) {
        this._clientsManager = new CommunityPostsPagesClientsManager({ pkc, pages: this });
        this.clients = this._clientsManager.clients;
    }
    async _fetchAndVerifyPage(opts) {
        const result = await super._fetchAndVerifyPage(opts);
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
    _parseRawPageIpfs(pageIpfs) {
        return parsePageIpfs(pageIpfs);
    }
    async getPage(getPageArgs) {
        // we need to make all updating community instances do the getPage call to cache _loadedUniqueCommentFromGetPage
        return await super.getPage(getPageArgs);
    }
    async _validatePage(pageIpfs, pageCid) {
        if (pageIpfs.comments.length === 0)
            return;
        const pageSortName = Object.entries(this.pageCids).find(([_, pageCid]) => pageCid === pageCid)?.[0];
        const verificationOpts = {
            pageCid,
            pageSortName,
            page: pageIpfs,
            resolveAuthorNames: this._clientsManager._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager,
            community: this._community,
            parentComment: { cid: undefined, postCid: undefined, depth: -1 },
            validatePages: this._clientsManager._pkc.validatePages,
            validateUpdateSignature: false, // no need because we verified that page cid matches its content
            abortSignal: this._community._getStopAbortSignal?.()
        };
        const signatureValidity = await verifyPage(verificationOpts);
        if (!signatureValidity.valid)
            throw new PKCError("ERR_POSTS_PAGE_IS_INVALID", {
                signatureValidity,
                verificationOpts
            });
    }
}
export class ModQueuePages extends BasePages {
    constructor(props) {
        super(props);
        this._parentComment = undefined;
    }
    resetPages() {
        this.pageCids = {};
        this.pages = {};
    }
    _initClientsManager(pkc) {
        this._clientsManager = new CommunityModQueueClientsManager({ pkc, pages: this });
        this.clients = this._clientsManager.clients;
    }
    async _fetchAndVerifyPage(opts) {
        const result = await super._fetchAndVerifyPage(opts);
        return { page: result.page, runtimeFields: result.runtimeFields };
    }
    _parseRawPageIpfs(pageIpfs) {
        return parseModQueuePageIpfs(pageIpfs);
    }
    async getPage(getPageArgs) {
        return await super.getPage(getPageArgs);
    }
    async _validatePage(pageIpfs, pageCid) {
        if (pageIpfs.comments.length === 0)
            return;
        const pageSortName = Object.entries(this.pageCids).find(([_, pageCid]) => pageCid === pageCid)?.[0];
        const verificationOpts = {
            pageCid,
            pageSortName,
            page: pageIpfs,
            resolveAuthorNames: this._clientsManager._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager,
            community: this._community,
            parentComment: { cid: undefined, postCid: undefined, depth: -1 },
            validatePages: this._clientsManager._pkc.validatePages,
            validateUpdateSignature: false, // no need because we verified that page cid matches its content
            abortSignal: this._community._getStopAbortSignal?.()
        };
        const signatureValidity = await verifyModQueuePage(verificationOpts);
        if (!signatureValidity.valid)
            throw new PKCError("ERR_MOD_QUEUE_PAGE_IS_INVALID", {
                signatureValidity,
                verificationOpts
            });
    }
}
//# sourceMappingURL=pages.js.map