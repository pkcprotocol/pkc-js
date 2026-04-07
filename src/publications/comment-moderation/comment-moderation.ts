import { PKC } from "../../pkc/pkc.js";
import Publication from "../publication.js";
import { hideClassPrivateProps, isIpfsCid } from "../../util.js";
import { PKCError } from "../../pkc-error.js";
import type { CommentModerationOptionsToSign, CommentModerationPubsubMessagePublication, CreateCommentModerationOptions } from "./types.js";
import type { PublicationTypeName } from "../../types.js";
import { signCommentModeration, verifyCommentModeration } from "../../signer/signatures.js";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";

export class CommentModeration extends Publication implements CommentModerationPubsubMessagePublication {
    commentCid!: CommentModerationPubsubMessagePublication["commentCid"];
    commentModeration!: CommentModerationPubsubMessagePublication["commentModeration"];
    override signature!: CommentModerationPubsubMessagePublication["signature"];

    override raw: { pubsubMessageToPublish?: CommentModerationPubsubMessagePublication } = {};
    override challengeRequest?: CreateCommentModerationOptions["challengeRequest"];

    constructor(pkc: PKC) {
        super(pkc);

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
        const o = opts.unsignedOptions as unknown as CommentModerationOptionsToSign;
        this.commentCid = o.commentCid;
        this.commentModeration = o.commentModeration;
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

    protected override async _signPublicationOptionsToPublish(
        cleanedPublication: unknown
    ): Promise<CommentModerationPubsubMessagePublication["signature"]> {
        return signCommentModeration({ commentMod: cleanedPublication as CommentModerationOptionsToSign, pkc: this._pkc });
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

    protected override async _validateSignatureHook() {
        const editObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish!));
        const signatureValidity = await verifyCommentModeration({
            moderation: editObj,
            resolveAuthorNames: this._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid) throw new PKCError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }

    override async publish(): Promise<void> {
        // TODO if publishing with content,reason, deleted, verify that publisher is original author
        if (!isIpfsCid(this.commentCid)) throw new PKCError("ERR_CID_IS_INVALID", { commentCid: this.commentCid });

        return super.publish();
    }
}
