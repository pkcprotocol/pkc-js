import Publication from "../publication.js";
import type { PublicationTypeName } from "../../types.js";
import { PKC } from "../../pkc/pkc.js";
import { signVote, verifyVote } from "../../signer/signatures.js";
import { hideClassPrivateProps } from "../../util.js";
import { PKCError } from "../../pkc-error.js";
import type { CreateVoteOptions, VoteOptionsToSign, VotePubsubMessagePublication } from "./types.js";
import * as remeda from "remeda";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";

// vote.signer is inherited from Publication
class Vote extends Publication implements VotePubsubMessagePublication {
    commentCid!: VotePubsubMessagePublication["commentCid"];
    vote!: VotePubsubMessagePublication["vote"]; // (upvote = 1, cancel vote = 0, downvote = -1)
    override signature!: VotePubsubMessagePublication["signature"];

    override raw: { pubsubMessageToPublish?: VotePubsubMessagePublication } = {};
    override challengeRequest?: CreateVoteOptions["challengeRequest"];

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
        const o = opts.unsignedOptions as unknown as VoteOptionsToSign;
        this.commentCid = o.commentCid;
        this.vote = o.vote;
    }

    _initLocalProps(props: {
        vote: VotePubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateVoteOptions["challengeRequest"];
    }): void {
        this._initRemoteProps(props.vote);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }

    protected override async _signPublicationOptionsToPublish(
        cleanedPublication: unknown
    ): Promise<VotePubsubMessagePublication["signature"]> {
        return signVote({ vote: cleanedPublication as VoteOptionsToSign, pkc: this._pkc });
    }

    _initRemoteProps(props: VotePubsubMessagePublication): void {
        super._initBaseRemoteProps(props);
        this.commentCid = props.commentCid;
        this.vote = props.vote;
        this.raw.pubsubMessageToPublish = props;
    }

    override getType(): PublicationTypeName {
        return "vote";
    }

    protected override async _validateSignatureHook() {
        const voteObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish!)); // Stringified here to simulate a message sent through IPNS/PUBSUB
        const signatureValidity = await verifyVote({
            vote: voteObj,
            resolveAuthorNames: this._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid) throw new PKCError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }
}

export default Vote;
