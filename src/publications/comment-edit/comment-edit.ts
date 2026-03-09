import { Plebbit } from "../../plebbit/plebbit.js";
import Publication from "../publication.js";
import { verifyCommentEdit } from "../../signer/signatures.js";
import { hideClassPrivateProps, isIpfsCid, throwWithErrorCode } from "../../util.js";
import type { CommentEditPubsubMessagePublication, CreateCommentEditOptions } from "./types.js";
import type { PublicationTypeName } from "../../types.js";
import type { SignerType } from "../../signer/types.js";

export class CommentEdit extends Publication implements CommentEditPubsubMessagePublication {
    commentCid!: CommentEditPubsubMessagePublication["commentCid"];
    content?: CommentEditPubsubMessagePublication["content"];
    reason?: CommentEditPubsubMessagePublication["reason"];
    deleted?: CommentEditPubsubMessagePublication["deleted"];
    flairs?: CommentEditPubsubMessagePublication["flairs"];
    spoiler?: CommentEditPubsubMessagePublication["spoiler"];
    nsfw?: CommentEditPubsubMessagePublication["nsfw"];

    override signature!: CommentEditPubsubMessagePublication["signature"];

    override raw: { pubsubMessageToPublish?: CommentEditPubsubMessagePublication } = {};
    override challengeRequest?: CreateCommentEditOptions["challengeRequest"];

    constructor(plebbit: Plebbit) {
        super(plebbit);

        // public method should be bound
        this.publish = this.publish.bind(this);

        hideClassPrivateProps(this);
    }

    _initLocalProps(props: {
        commentEdit: CommentEditPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateCommentEditOptions["challengeRequest"];
    }) {
        this._initPubsubPublicationProps(props.commentEdit);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }

    _initPubsubPublicationProps(props: CommentEditPubsubMessagePublication): void {
        this.raw.pubsubMessageToPublish = props;
        super._initBaseRemoteProps(props);
        this.commentCid = props.commentCid;
        this.content = props.content;
        this.reason = props.reason;
        this.deleted = props.deleted;
        this.flairs = props.flairs;
        this.spoiler = props.spoiler;
        this.nsfw = props.nsfw;
    }

    override toJSONPubsubMessagePublication(): CommentEditPubsubMessagePublication {
        if (!this.raw.pubsubMessageToPublish) throw Error("Need to define local CommentEditPubsubMessage first");
        return this.raw.pubsubMessageToPublish;
    }

    override getType(): PublicationTypeName {
        return "commentEdit";
    }

    private async _validateSignature() {
        const editObj = JSON.parse(JSON.stringify(this.toJSONPubsubMessagePublication()));
        const signatureValidity = await verifyCommentEdit({
            edit: editObj,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager,
            overrideAuthorAddressIfInvalid: true
        }); // If author domain is not resolving to signer, then don't throw an error
        if (!signatureValidity.valid) throwWithErrorCode("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }

    override async publish(): Promise<void> {
        // TODO if publishing with content,reason, deleted, verify that publisher is original author
        if (!isIpfsCid(this.commentCid)) throwWithErrorCode("ERR_CID_IS_INVALID", { commentCid: this.commentCid });

        await this._validateSignature();

        return super.publish();
    }
}
