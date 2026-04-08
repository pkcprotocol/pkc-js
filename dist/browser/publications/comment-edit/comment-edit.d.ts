import { PKC } from "../../pkc/pkc.js";
import Publication from "../publication.js";
import type { CommentEditPubsubMessagePublication, CreateCommentEditOptions } from "./types.js";
import type { PublicationTypeName } from "../../types.js";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";
export declare class CommentEdit extends Publication implements CommentEditPubsubMessagePublication {
    commentCid: CommentEditPubsubMessagePublication["commentCid"];
    content?: CommentEditPubsubMessagePublication["content"];
    reason?: CommentEditPubsubMessagePublication["reason"];
    deleted?: CommentEditPubsubMessagePublication["deleted"];
    flairs?: CommentEditPubsubMessagePublication["flairs"];
    spoiler?: CommentEditPubsubMessagePublication["spoiler"];
    nsfw?: CommentEditPubsubMessagePublication["nsfw"];
    signature: CommentEditPubsubMessagePublication["signature"];
    raw: {
        pubsubMessageToPublish?: CommentEditPubsubMessagePublication;
    };
    challengeRequest?: CreateCommentEditOptions["challengeRequest"];
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
        commentEdit: CommentEditPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateCommentEditOptions["challengeRequest"];
    }): void;
    protected _signPublicationOptionsToPublish(cleanedPublication: unknown): Promise<CommentEditPubsubMessagePublication["signature"]>;
    _initPubsubPublicationProps(props: CommentEditPubsubMessagePublication): void;
    getType(): PublicationTypeName;
    protected _validateSignatureHook(): Promise<void>;
    publish(): Promise<void>;
}
