import Publication from "../publication.js";
import { signCommentEdit, verifyCommentEdit } from "../../signer/signatures.js";
import { hideClassPrivateProps, isIpfsCid } from "../../util.js";
import { PKCError } from "../../pkc-error.js";
export class CommentEdit extends Publication {
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
        this.content = o.content;
        this.reason = o.reason;
        this.deleted = o.deleted;
        this.flairs = o.flairs;
        this.spoiler = o.spoiler;
        this.nsfw = o.nsfw;
    }
    _initLocalProps(props) {
        this._initPubsubPublicationProps(props.commentEdit);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }
    async _signPublicationOptionsToPublish(cleanedPublication) {
        return signCommentEdit({ edit: cleanedPublication, pkc: this._pkc });
    }
    _initPubsubPublicationProps(props) {
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
    getType() {
        return "commentEdit";
    }
    async _validateSignatureHook() {
        const editObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish));
        const signatureValidity = await verifyCommentEdit({
            edit: editObj,
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
//# sourceMappingURL=comment-edit.js.map