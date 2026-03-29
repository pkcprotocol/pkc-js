import { Plebbit } from "../../plebbit/plebbit.js";
import Publication from "../publication.js";
import { signCommentEdit, verifyCommentEdit } from "../../signer/signatures.js";
import { hideClassPrivateProps, isIpfsCid } from "../../util.js";
import { PlebbitError } from "../../plebbit-error.js";
import type { CommentEditOptionsToSign, CommentEditPubsubMessagePublication, CreateCommentEditOptions } from "./types.js";
import type { PublicationTypeName } from "../../types.js";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";

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

    override _initUnsignedLocalProps<
        T extends {
            signer: SignerType;
            communityAddress: string;
            timestamp: number;
            protocolVersion: string;
            author?: Record<string, unknown>;
        }
    >(opts: { unsignedOptions: T; challengeRequest?: CreatePublicationOptions["challengeRequest"] }) {
        super._initUnsignedLocalProps(opts);
        const o = opts.unsignedOptions as unknown as CommentEditOptionsToSign;
        this.commentCid = o.commentCid;
        this.content = o.content;
        this.reason = o.reason;
        this.deleted = o.deleted;
        this.flairs = o.flairs;
        this.spoiler = o.spoiler;
        this.nsfw = o.nsfw;
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

    protected override async _signPublicationOptionsToPublish(
        cleanedPublication: unknown
    ): Promise<CommentEditPubsubMessagePublication["signature"]> {
        return signCommentEdit({ edit: cleanedPublication as CommentEditOptionsToSign, plebbit: this._plebbit });
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

    override getType(): PublicationTypeName {
        return "commentEdit";
    }

    protected override async _validateSignatureHook() {
        const editObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish!));
        const signatureValidity = await verifyCommentEdit({
            edit: editObj,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager
        });

        if (!signatureValidity.valid) throw new PlebbitError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }

    override async publish(): Promise<void> {
        // TODO if publishing with content,reason, deleted, verify that publisher is original author
        if (!isIpfsCid(this.commentCid)) throw new PlebbitError("ERR_CID_IS_INVALID", { commentCid: this.commentCid });

        return super.publish();
    }
}
