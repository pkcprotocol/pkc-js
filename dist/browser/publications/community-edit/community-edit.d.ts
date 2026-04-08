import Publication from "../publication.js";
import type { PublicationTypeName } from "../../types.js";
import { PKC } from "../../pkc/pkc.js";
import type { CreateCommunityEditPublicationOptions, CommunityEditPubsubMessagePublication } from "./types.js";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";
declare class CommunityEdit extends Publication implements CommunityEditPubsubMessagePublication {
    communityEdit: CommunityEditPubsubMessagePublication["communityEdit"];
    signature: CommunityEditPubsubMessagePublication["signature"];
    raw: {
        pubsubMessageToPublish?: CommunityEditPubsubMessagePublication;
    };
    challengeRequest?: CreateCommunityEditPublicationOptions["challengeRequest"];
    constructor(pkc: PKC);
    _initUnsignedLocalProps<T extends {
        signer: SignerType;
        communityAddress: string;
        timestamp: number;
        protocolVersion: string;
        author?: Record<string, unknown>;
    }>(opts: {
        unsignedOptions: T;
        challengeRequest?: CreatePublicationOptions["challengeRequest"];
    }): void;
    _initLocalProps(props: {
        communityEdit: CommunityEditPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateCommunityEditPublicationOptions["challengeRequest"];
    }): void;
    protected _signPublicationOptionsToPublish(cleanedPublication: unknown): Promise<CommunityEditPubsubMessagePublication["signature"]>;
    _initRemoteProps(props: CommunityEditPubsubMessagePublication): void;
    getType(): PublicationTypeName;
    protected _validateSignatureHook(): Promise<void>;
}
export default CommunityEdit;
