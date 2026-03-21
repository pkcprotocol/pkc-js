import { Plebbit } from "../../plebbit/plebbit.js";
import Publication from "../publication.js";
import { hideClassPrivateProps, isIpfsCid } from "../../util.js";
import { PlebbitError } from "../../plebbit-error.js";
import type { CommentModerationPubsubMessagePublication, CreateCommentModerationOptions } from "./types.js";
import type { PublicationTypeName } from "../../types.js";
import { verifyCommentModeration } from "../../signer/signatures.js";
import type { SignerType } from "../../signer/types.js";

export class CommentModeration extends Publication implements CommentModerationPubsubMessagePublication {
    commentCid!: CommentModerationPubsubMessagePublication["commentCid"];
    commentModeration!: CommentModerationPubsubMessagePublication["commentModeration"];
    override signature!: CommentModerationPubsubMessagePublication["signature"];

    override raw: { pubsubMessageToPublish?: CommentModerationPubsubMessagePublication } = {};
    override challengeRequest?: CreateCommentModerationOptions["challengeRequest"];

    constructor(plebbit: Plebbit) {
        super(plebbit);

        // public method should be bound
        this.publish = this.publish.bind(this);

        hideClassPrivateProps(this);
    }

    _initLocalProps(props: {
        commentModeration: CommentModerationPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateCommentModerationOptions["challengeRequest"];
    }) {
        this._initPubsubPublication(props.commentModeration);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }

    _initPubsubPublication(pubsubMsgPub: CommentModerationPubsubMessagePublication) {
        super._initBaseRemoteProps(pubsubMsgPub);
        this.commentCid = pubsubMsgPub.commentCid;
        this.commentModeration = pubsubMsgPub.commentModeration;
        this.raw.pubsubMessageToPublish = pubsubMsgPub;
    }

    override getType(): PublicationTypeName {
        return "commentModeration";
    }

    private async _validateSignature() {
        const editObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish!));
        const signatureValidity = await verifyCommentModeration({
            moderation: editObj,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid) throw new PlebbitError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }

    override async publish(): Promise<void> {
        // TODO if publishing with content,reason, deleted, verify that publisher is original author
        if (!isIpfsCid(this.commentCid)) throw new PlebbitError("ERR_CID_IS_INVALID", { commentCid: this.commentCid });

        await this._validateSignature();

        return super.publish();
    }
}
