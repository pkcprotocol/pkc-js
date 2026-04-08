import Publication from "../publication.js";
import { hideClassPrivateProps, isIpfsCid } from "../../util.js";
import { PKCError } from "../../pkc-error.js";
import { signCommentModeration, verifyCommentModeration } from "../../signer/signatures.js";
export class CommentModeration extends Publication {
    constructor(pkc) {
        super(pkc);
        this.raw = {};
        // public method should be bound
        this.publish = this.publish.bind(this);
        hideClassPrivateProps(this);
    }
    _initUnsignedLocalProps(opts) {
        super._initUnsignedLocalProps(opts);
        const o = opts.unsignedOptions;
        this.commentCid = o.commentCid;
        this.commentModeration = o.commentModeration;
    }
    _initLocalProps(props) {
        this._initPubsubPublication(props.commentModeration);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }
    async _signPublicationOptionsToPublish(cleanedPublication) {
        return signCommentModeration({ commentMod: cleanedPublication, pkc: this._pkc });
    }
    _initPubsubPublication(pubsubMsgPub) {
        super._initBaseRemoteProps(pubsubMsgPub);
        this.commentCid = pubsubMsgPub.commentCid;
        this.commentModeration = pubsubMsgPub.commentModeration;
        this.raw.pubsubMessageToPublish = pubsubMsgPub;
    }
    getType() {
        return "commentModeration";
    }
    async _validateSignatureHook() {
        const editObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish));
        const signatureValidity = await verifyCommentModeration({
            moderation: editObj,
            resolveAuthorNames: this._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid)
            throw new PKCError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }
    async publish() {
        // TODO if publishing with content,reason, deleted, verify that publisher is original author
        if (!isIpfsCid(this.commentCid))
            throw new PKCError("ERR_CID_IS_INVALID", { commentCid: this.commentCid });
        return super.publish();
    }
}
//# sourceMappingURL=comment-moderation.js.map