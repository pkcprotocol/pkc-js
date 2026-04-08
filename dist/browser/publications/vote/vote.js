import Publication from "../publication.js";
import { signVote, verifyVote } from "../../signer/signatures.js";
import { hideClassPrivateProps } from "../../util.js";
import { PKCError } from "../../pkc-error.js";
// vote.signer is inherited from Publication
class Vote extends Publication {
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
        this.vote = o.vote;
    }
    _initLocalProps(props) {
        this._initRemoteProps(props.vote);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }
    async _signPublicationOptionsToPublish(cleanedPublication) {
        return signVote({ vote: cleanedPublication, pkc: this._pkc });
    }
    _initRemoteProps(props) {
        super._initBaseRemoteProps(props);
        this.commentCid = props.commentCid;
        this.vote = props.vote;
        this.raw.pubsubMessageToPublish = props;
    }
    getType() {
        return "vote";
    }
    async _validateSignatureHook() {
        const voteObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish)); // Stringified here to simulate a message sent through IPNS/PUBSUB
        const signatureValidity = await verifyVote({
            vote: voteObj,
            resolveAuthorNames: this._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid)
            throw new PKCError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }
}
export default Vote;
//# sourceMappingURL=vote.js.map