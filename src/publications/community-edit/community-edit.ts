import Publication from "../publication.js";
import type { PublicationTypeName } from "../../types.js";
import { PKC } from "../../pkc/pkc.js";
import { hideClassPrivateProps } from "../../util.js";
import { PKCError } from "../../pkc-error.js";
import type {
    CreateCommunityEditPublicationOptions,
    CommunityEditPublicationOptionsToSign,
    CommunityEditPubsubMessagePublication
} from "./types.js";
import type { SignerType } from "../../signer/types.js";
import { signCommunityEdit, verifyCommunityEdit } from "../../signer/signatures.js";
import type { CreatePublicationOptions } from "../../types.js";

// subplebbitEdit.signer is inherited from Publication
class CommunityEdit extends Publication implements CommunityEditPubsubMessagePublication {
    subplebbitEdit!: CommunityEditPubsubMessagePublication["subplebbitEdit"];
    override signature!: CommunityEditPubsubMessagePublication["signature"];

    override raw: { pubsubMessageToPublish?: CommunityEditPubsubMessagePublication } = {};
    override challengeRequest?: CreateCommunityEditPublicationOptions["challengeRequest"];

    constructor(plebbit: PKC) {
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
        const o = opts.unsignedOptions as unknown as CommunityEditPublicationOptionsToSign;
        this.subplebbitEdit = o.subplebbitEdit;
    }

    _initLocalProps(props: {
        subplebbitEdit: CommunityEditPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateCommunityEditPublicationOptions["challengeRequest"];
    }): void {
        this._initRemoteProps(props.subplebbitEdit);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }

    protected override async _signPublicationOptionsToPublish(
        cleanedPublication: unknown
    ): Promise<CommunityEditPubsubMessagePublication["signature"]> {
        return signCommunityEdit({
            subplebbitEdit: cleanedPublication as CommunityEditPublicationOptionsToSign,
            plebbit: this._plebbit
        });
    }

    _initRemoteProps(props: CommunityEditPubsubMessagePublication): void {
        super._initBaseRemoteProps(props);
        this.subplebbitEdit = props.subplebbitEdit;
        this.raw.pubsubMessageToPublish = props;
    }

    override getType(): PublicationTypeName {
        return "subplebbitEdit";
    }

    protected override async _validateSignatureHook() {
        const subplebbitEditObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish!)); // Stringified here to simulate a message sent through IPNS/PUBSUB
        const signatureValidity = await verifyCommunityEdit({
            subplebbitEdit: subplebbitEditObj,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid) throw new PKCError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }
}

export default CommunityEdit;
