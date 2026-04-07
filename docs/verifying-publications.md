## verifyAuthor

This function will take a JSON of either `CommentEditPubsubMessage`, `VotePubsubMessage` or `CommentPubsubMessage`. All of them will have an `author` field. The function will split into two parts:

-   If no author address is supplemented, then the aforementioned publication is invalid.
-   Resolving and verifying author domain
    -   The following condition will need to be true
        -   `author.address` is a domain
        -   `pkc.resolverAuthorAddress` is `true`
        -   Function parameter `returnDerivedAuthorAddressIfInvalid` is `true`
    -   `verifyAuthor` will then resolve the author domain using `ethers` (assumed to be an ENS domain), and compare the resolved address with the address derived from `signature.publicKey`. If they're not equal then `{valid: true, newAddress: derivedAddress}` is returned, where `newAddress` will be used to override `author.address`, if they're not equivalent
-   Validating regular CID address (12D...)
    -   `author.address` has to be a non-domain
    -   Create a `PeerId` instance for `author.address` and `signature.publicKey`
    -   Compare the derivation of `author.address` and `signature.publicKey`
    -   If they're not equal, then return `{valid: false, reason: "comment.author.address doesn't match comment.signature.publicKey"}`
-   Otherwise, return `{valid: true}`

## verifyPublicationSignature

This function will take a JSON object that has signature field. One of the following types `CommentEditPubsubMessage | VotePubsubMessage | CommentPubsubMessage | CommentUpdate | CommunityIpfsType | ChallengeRequestMessageType | ChallengeMessageType | ChallengeAnswerMessageType | ChallengeVerificationMessageType`

-   Create an object the same as the argument, without keys that have null or undefined values.
-   call `cborg.encode` on the new object
-   Create signature from the encoded object, and compare it with the signature provided by the arguments
-   If they're the same, return `true`
-   Otherwise, return `false`

## verifyPublicationWithAuthor

This function will take a JSON object that has signature field. Could be `VotePubsubMessage | CommentPubsubMessage | CommentEditPubsubMessage`, as well as `overrideAuthorAddressIfInvalid` boolean flag

-   Verify the author validity by calling `verifyAuthor`
    -   If `author` is invalid, then return `{valid: false, reason: comment.author.address doesn't match comment.signature.publicKey"}`
    -   Otherwise if `author` is valid, and returned object has `newAddress` defined, return `{ valid: true, newAddress: authorSignatureValidity.newAddress }`
        -   If `newAddress` is defined, and `overrideAuthorAddressIfInvalid=true`, then `author.address` will be overridden with `newAddress`
-   Call `verifyPublicationSignature`, if result is `false` return `{valid: false, reason: "Signature of publication is invalid"}`
-   Otherwise, return `{valid: true}`

## verifyVote

-   This function will take `VotePubsubMessage` as a parameter.
-   Call `verifyPublicationWithAuthor`
-   If it return invalid, then return the same object `verifyPublication` returned
-   Otherwise return `{valid: true}`

## verifyCommentEdit

-   Same as [verifyVote](#verifyvote), except `verifyCommentEdit` will take a `CommentEditPubsubMessage`

## verifyComment

-   The function will take a `CommentPubsubMessage | CommentIpfsType`. Both of these types do not contain CommentUpdate fields.It will also take `overrideAuthorAddressIfInvalid` boolean argument that will override the comment parameter author address if it was invalid.

-   Call `verifyPublicationWithAuthor`
-   If it return invalid, then return the same object `verifyPublication` returned
-   Otherwise check if `verifyPublicationWithAuthor` returns `newAddress`, if so then override `comment.author.address` with `newAddress`

## verifyCommunity

-   The function will take a `CommunityIpfsType` as a parameter.

-   Verify the posts of the community by iterating through all of them and calling `verifyPage`
-   Validate signature of community object with `verifyPublicationSignature`
-   Return result of `verifyPublicationSignature` if invalid
-   If community address is a domain
    -   Resolve it to PKC address
-   Create a PeerId instance from PKC address
-   Compare address PeerId instance with PeerId instance created from public key in signature
-   If they're not equal, return invalid
-   Else, return valid

## verifyPage

-   Takes `PageIpfs`, community address, and the parent cid of page (if community then undefined, if page was under a comment, then it should be the comment cid) for parameters
-   (1) Iterate over the comments within page
    -   If the community address of comment is not the community address provided by function argument, `verifyPage` will return invalid
    -   If `comment.parentCid` does not equal parent cid of the page, return invalid
    -   Call `verifyComment` on comment
        -   If invalid, return invalid
    -   Call `verifyCommentUpdate` on comment update
        -   If invalid, return invalid
-   Return valid if we're done with the iteration

## verifyCommentUpdate

-   Takes `CommentUpdate`, the address of the community, cid, and signature of the comment as parameters.

-   If update has `edit` field, but the `edit.signature` has a different public key than the public key of the signature of comment
    -   return invalid
-   If the signature of the update is produced with keys different than the community
    -   return invalid
-   If the `cid` field in `CommentUpdate` is different than cid of the comment
    -   return invalid
-   Iterate through pages in `update.replies`, and call `verifyPage` on them

    -   If any of them is invalid, return invalid

-   Call `verifyPublicationSignature` on CommentUpdate object
    -   If invalid, return invalid
-   Else, return valid

## verifyChallengeRequest

-   Takes `ChallengeRequestMessageType` as a parameter

-   Call `verifyPublicationSignature` on the single parameter
    -   If invalid, return invalid
-   Else, return valid

## verifyChallengeMessage

-   Takes `ChallengeMessageType` as a parameter

-   Call `verifyPublicationSignature` on the single parameter
    -   If invalid, return invalid
-   Else, return valid

## verifyChallengeAnswer

-   Takes `ChallengeAnswerMessageType` as a parameter

-   Call `verifyPublicationSignature` on the single parameter
    -   If invalid, return invalid
-   Else, return valid

## verifyChallengeVerification

-   Takes `ChallengeVerificationMessageType` as a parameter

-   Call `verifyPublicationSignature` on the single parameter
    -   If invalid, return invalid
-   Else, return valid
