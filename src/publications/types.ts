import { PKCError } from "../pkc-error.js";
import type {
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeVerificationMessageType
} from "../pubsub-messages/types.js";

import type { Comment } from "./comment/comment.js";
import Publication from "./publication.js";

export type PublicationPublishingState =
    | "stopped"
    | "resolving-community-name"
    | "fetching-community-ipns"
    | "fetching-community-ipfs"
    | "publishing-challenge-request"
    | "waiting-challenge"
    | "waiting-challenge-answers"
    | "publishing-challenge-answer"
    | "waiting-challenge-verification"
    | "failed"
    | "succeeded";

export type PublicationState = "publishing" | "stopped";

export interface PublicationEvents {
    challengerequest: (request: DecryptedChallengeRequestMessageType) => void;
    challenge: (challenge: DecryptedChallengeMessageType) => void;
    challengeanswer: (answer: DecryptedChallengeAnswerMessageType) => void;
    challengeverification: (verification: DecryptedChallengeVerificationMessageType, decryptedComment?: Comment) => void; // Should we include the updated publication instance here? not sure
    error: (error: PKCError | Error) => void;

    // State changes
    publishingstatechange: (newState: Publication["publishingState"]) => void;
    statechange: (newState: Publication["state"]) => void;

    // For comment only
    update: (updatedInstance: Comment) => void;
    updatingstatechange: (newState: Comment["updatingState"]) => void;

    removeListener: (eventName: string, listener: Function) => void;
}

export type PublicationEventArgs<T extends keyof PublicationEvents> = Parameters<PublicationEvents[T]>;

export type PublicationRpcErrorToTransmit = PublicationEventArgs<"error">[0] & {
    details?: PKCError["details"] & {
        newPublishingState?: Publication["publishingState"];
        publishThrowError?: boolean; // if true, the error was thrown by publish() not emitted by the publication instance
    };
};

export type RpcPublishResult = number; // subscriptionId
