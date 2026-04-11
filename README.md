*Telegram group for this repo https://t.me/pkc_js*

`pkc-js` is an NPM module to wrap around the IPFS APIs used by PKC. It is used in all clients: CLI, Electron (desktop GUI) and web.

### Glossary:

- CID: https://docs.ipfs.io/concepts/content-addressing/
- IPNS: https://docs.ipfs.io/concepts/ipns/#example-ipns-setup-with-cli
- IPNS name: hash of a public key, the private key is used by community owners for signing IPNS records, and by authors for signing posts and comments
- Pubsub topic: the string to publish/subscribe to in the pubsub https://github.com/ipfs/js-ipfs/blob/master/docs/core-api/PUBSUB.md#ipfspubsubsubscribetopic-handler-options and https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.0.md#topic-membership
- IPNS record: https://github.com/ipfs/specs/blob/master/IPNS.md#ipns-record
- IPNS signature: https://github.com/ipfs/notes/issues/249
- PKC signature types: https://github.com/pkcprotocol/pkc-js/blob/master/docs/signatures.md
- PKC encryption types: https://github.com/pkcprotocol/pkc-js/blob/master/docs/encryption.md

Note: IPFS files are immutable, fetched by their CID, which is a hash of their content. IPNS records are mutable, fetched by their IPNS name, which is the hash of a public key. The private key's owner can update the content. Always use IPFS files over IPNS records when possible because they are much faster to fetch.

### Schema:

```js
Address: string // a PKC author, community or multisub "address" can be a crypto domain like memes.bso, an IPNS name, an ethereum address, etc. How to resolve ENS names https://github.com/pkcprotocol/pkc-js/blob/master/docs/ens.md
Publication {
  author: Author
  communityPublicKey: string // IPNS public key of the community this publication is directed to
  communityName?: string // optional crypto domain name of the community (e.g. 'memes.bso')
  // note: communityAddress is available as a convenience instance property at runtime, but is not part of the wire format
  timestamp: number // number in seconds
  signature: Signature // sign immutable fields like author, title, content, timestamp to prevent tampering
  protocolVersion: '1.0.0' // semantic version of the protocol https://semver.org/
}
Comment extends Publication /* (IPFS file) */ {
  parentCid?: string // same as postCid for top level comments, undefined for posts
  content?: string
  title?: string
  link?: string
  linkWidth?: number // author can optionally provide dimensions of image/video link which helps UI clients with infinite scrolling feeds
  linkHeight?: number
  linkHtmlTagName?: 'a' | 'img' | 'video' | 'audio' // author can optionally provide the HTML element to use for the link
  spoiler?: boolean
  nsfw?: boolean
  flairs?: Flair[] // arbitrary colored strings added by the author or mods to describe the author or comment
  quotedCids?: string[] // CIDs of comments being quoted/referenced in this reply
  // below are added by community owner, not author
  previousCid?: string // each comment/post is a linked list of other comments/posts with same comment.depth and comment.parentCid, undefined if first comment in list
  postCid?: string // helps faster loading post info for reply direct linking, undefined for posts, a post can't know its own CID
  depth: number // 0 = post, 1 = top level reply, 2+ = nested reply
  thumbnailUrl?: string // optionally fetched by community owner, some web pages have thumbnail urls in their meta tags https://moz.com/blog/meta-data-templates-123
  thumbnailUrlWidth?: number // community owner can optionally provide dimensions of thumbails which helps UI clients with infinite scrolling feeds
  thumbnailUrlHeight?: number
}
Vote extends Publication {
  commentCid: string
  vote: 1 | -1 | 0 // 0 is needed to cancel a vote
}
CommentEdit extends Publication {
  commentCid: string
  content?: string
  deleted?: boolean
  flairs?: Flair[]
  spoiler?: boolean
  nsfw?: boolean
  reason?: string
}
CommentModeration extends Publication {
  commentCid: string
  commentModeration: {
    flairs?: Flair[]
    spoiler?: boolean
    nsfw?: boolean
    pinned?: boolean
    locked?: boolean
    archived?: boolean
    approved?: boolean
    removed?: boolean
    purged?: boolean
    reason?: string
    author?: {
      flairs?: Flair[]
      banExpiresAt?: number
    }
  }
}
CommunityEdit extends Publication {
  communityEdit: CreateCommunityOptions
}
MultisubEdit extends CreateMultisubOptions, Publication {} // not yet implemented
CommentUpdate /* (IPFS file) */ {
  cid: string // cid of the comment, need it in signature to prevent attack
  edit?: AuthorCommentEdit // most recent edit by comment author, commentUpdate.edit.content, commentUpdate.edit.deleted, commentUpdate.edit.flairs override Comment instance props. Validate commentUpdate.edit.signature
  upvoteCount: number
  downvoteCount: number
  replies?: Pages // only preload page 1 sorted by 'best', might preload more later, only provide sorting for posts (not comments) that have 100+ child comments
  replyCount: number
  childCount?: number // the total of direct children of the comment, does not include indirect children
  number?: number // sequential comment number assigned by the community
  postNumber?: number // sequential post number assigned by the community
  flairs?: Flair[] // arbitrary colored strings to describe the comment, added by mods, override comment.flairs and comment.edit.flairs (which are added by author)
  spoiler?: boolean
  nsfw?: boolean
  pinned?: boolean
  locked?: boolean
  archived?: boolean
  approved?: boolean // if comment was pending approval and it got approved or disapproved
  removed?: boolean // mod deleted a comment
  reason?: string // reason the mod took a mod action
  updatedAt: number // timestamp in seconds the CommentUpdate was updated
  protocolVersion: '1.0.0' // semantic version of the protocol https://semver.org/
  signature: Signature // signature of the CommentUpdate by the community owner to protect against malicious gateway
  author?: { // add commentUpdate.author.community to comment.author.community, override comment.author.flairs with commentUpdate.author.community.flairs if any
    community: CommunityAuthor
  }
  lastReplyTimestamp?: number // the timestamp of the most recent direct or indirect child of the comment
  lastChildCid?: string // the CID of the most recent direct child of the comment
}
Author {
  address: string
  shortAddress: string // not part of IPFS files, added to `Author` instance as convenience. Copy address, if address is a hash, remove hash prefix and trim to 12 first chars
  name?: string // author chosen username
  previousCommentCid?: string // linked list of the author's comments
  displayName?: string
  wallets?: {[chainTicker: string]: Wallet}
  avatar?: Nft
  flairs?: Flair[] // (added by author originally, can be overridden by commentUpdate.author.community.flairs)
  community?: CommunityAuthor // (added by CommentUpdate) up to date author properties specific to the community it's in
}
CommunityAuthor {
  banExpiresAt?: number // (added by moderator only) timestamp in second, if defined the author was banned for this comment
  flairs?: Flair[] // (added by moderator only) for when a mod wants to edit an author's flairs
  postScore: number // total post karma in the community
  replyScore: number // total reply karma in the community
  lastCommentCid: string // last comment by the author in the community, can be used with author.previousCommentCid to get a recent author comment history in all communities
  firstCommentTimestamp: number // timestamp of the first comment by the author in the community, used for account age based challenges
}
Wallet {
  address: string
  timestamp: number // in seconds, allows partial blocking multiple authors using the same wallet
  signature: Signature // type 'eip191' {domainSeparator:"plebbit-author-wallet",authorAddress:"${authorAddress}",timestamp:"${wallet.timestamp}"}
  // ...will add more stuff later, like signer or send/sign or balance
}
Nft {
  chainTicker: string // ticker of the chain, like eth, avax, sol, etc in lowercase
  timestamp: number // in seconds, needed to mitigate multiple users using the same signature
  address: string // address of the NFT contract
  id: string // tokenId or index of the specific NFT used, must be string type, not number
  signature: Signature // proof that author.address owns the nft
  // how to resolve and verify NFT signatures https://github.com/pkcprotocol/pkc-js/blob/master/docs/nft.md
}
Signature {
  signature: string // data in base64
  publicKey: string // 32 bytes base64 string
  type: 'ed25519' | 'eip191' // multiple versions/types to allow signing with metamask/other wallet or to change the signature fields or algorithm
  signedPropertyNames: string[] // the fields that were signed as part of the signature e.g. ['title', 'content', 'author', etc.] client should require that certain fields be signed or reject the publication, e.g. 'content', 'author', 'timestamp' are essential
}
Signer {
  privateKey?: string // 32 bytes base64 string
  type: 'ed25519' // eip191 is only used for wallet/NFT signatures, not for Signer instances
  publicKey?: string // 32 bytes base64 string
  address: string // public key hash, not needed for signing
  ipfsKey?: IpfsKey // a Key object used for importing into IpfsHttpClient https://docs.ipfs.io/reference/cli/#ipfs-key-import
}
Community /* (IPNS record, identified by community's public key) */ {
  address: string // instance-only convenience property, not part of the IPNS record. Validate community address in signature to prevent a crypto domain resolving to an impersonated community
  title?: string
  description?: string
  roles?: {[authorAddress: string]: CommunityRole} // each author address can be mapped to 1 CommunityRole
  pubsubTopic?: string // the string to publish to in the pubsub, a public key of the community owner's choice
  lastPostCid?: string // the most recent post in the linked list of posts
  lastCommentCid?: string // the most recent comment (posts and replies included), last comment is often displayed with a list of forums
  posts?: Pages // only preload page 1 sorted by 'hot', might preload more later, comments should include Comment + CommentUpdate data
  statsCid?: string
  createdAt: number
  updatedAt: number
  features?: CommunityFeatures
  suggested?: CommunitySuggested
  rules?: string[]
  flairs?: {[key: 'post' | 'author']: Flair[]} // list of post/author flairs authors and mods can choose from
  protocolVersion: '1.0.0' // semantic version of the protocol https://semver.org/
  encryption: CommunityEncryption
  signature: Signature // signature of the Community update by the community owner to protect against malicious gateway
}
CommunitySuggested { // values suggested by the community owner, the client/user can ignore them without breaking interoperability
  primaryColor?: string
  secondaryColor?: string
  avatarUrl?: string
  bannerUrl?: string
  backgroundUrl?: string
  language?: string
  // TODO: menu links, wiki pages, sidebar widgets
}
CommunityFeatures { // any boolean that changes the functionality of the community, add "no" in front if doesn't default to false
  // implemented
  noUpvotes?: boolean
  noPostUpvotes?: boolean
  noReplyUpvotes?: boolean
  noDownvotes?: boolean
  noPostDownvotes?: boolean
  noReplyDownvotes?: boolean
  requirePostLink?: boolean // require post.link be defined and a valid https url
  requirePostLinkIsMedia?: boolean // require post.link be media, e.g. for imageboards
  requireReplyLink?: boolean // require reply.link be defined and a valid https url
  requireReplyLinkIsMedia?: boolean // require reply.link be media
  noMarkdownImages?: boolean // don't embed images in text posts markdown
  noMarkdownVideos?: boolean // don't embed videos in text posts markdown
  noMarkdownAudio?: boolean // don't embed audio in text posts markdown
  noVideos?: boolean // block all comments with video links
  noImages?: boolean // block all comments with image links
  noAudio?: boolean // block all comments with audio links
  noSpoilers?: boolean // author can't set spoiler = true on any comment
  noVideoReplies?: boolean // block only replies with video links
  noImageReplies?: boolean // block only replies with image links
  noAudioReplies?: boolean // block only replies with audio links
  noSpoilerReplies?: boolean // author can't set spoiler = true on replies
  noNestedReplies?: boolean // no nested replies, like old school forums and 4chan. Maximum depth is 1
  safeForWork?: boolean // informational flag indicating this community is safe for work
  pseudonymityMode?: 'per-post' | 'per-reply' | 'per-author'
  authorFlairs?: boolean // authors can choose their own author flairs (otherwise only mods can)
  requireAuthorFlairs?: boolean // force authors to choose an author flair before posting
  postFlairs?: boolean // authors can choose their own post flairs (otherwise only mods can)
  requirePostFlairs?: boolean // force authors to choose a post flair before posting
  // not implemented
  noPolls?: boolean
  noCrossposts?: boolean
  markdownImageReplies?: boolean
  markdownVideoReplies?: boolean
}
CommunityEncryption {
  type: 'ed25519-aes-gcm' // https://github.com/pkcprotocol/pkc-js/blob/master/docs/encryption.md
  publicKey: string // 32 bytes base64 string
}
CommunityRole {
  role: 'owner' | 'admin' | 'moderator'
  // TODO: custom roles with other props
}
Flair {
  text: string
  backgroundColor?: string
  textColor?: string
  expiresAt?: number // timestamp in seconds, a flair assigned to an author by a mod will follow the author in future comments, unless it expires
}
Pages {
  pages: {[key: PostsSortType | RepliesSortType]: Page} // e.g. community.posts.pages.hot.comments[0].cid = '12D3KooW...'
  pageCids: {[key: PostsSortType | RepliesSortType]: pageCid} // e.g. community.posts.pageCids.topAll = '12D3KooW...'
}
Page {
  nextCid: string // get next page (sorted by the same sort type)
  comments: Comment[] // Comments should include merged Comment and CommentUpdate
}
PageIpfs /* (IPFS file) */ {
  nextCid: string // get next page (sorted by the same sort type)
  comments: PageIpfsComment[] // PageIpfs is fetched from IPFS, then Comments and CommentUpdates are merged to create the Page instance
}
PageIpfsComment {
  comment: Comment
  commentUpdate: CommentUpdate
}
PostsSortType: 'hot' | 'new' | 'active' | 'topHour' | 'topDay' | 'topWeek' | 'topMonth' | 'topYear' | 'topAll'
RepliesSortType: 'best' | 'new' | 'old' | 'newFlat' | 'oldFlat'
CommunityStats {
  hourActiveUserCount: number
  dayActiveUserCount: number
  weekActiveUserCount: number
  monthActiveUserCount: number
  yearActiveUserCount: number
  allActiveUserCount: number
  hourPostCount: number
  dayPostCount: number
  weekPostCount: number
  monthPostCount: number
  yearPostCount: number
  allPostCount: number
  hourReplyCount: number
  dayReplyCount: number
  weekReplyCount: number
  monthReplyCount: number
  yearReplyCount: number
  allReplyCount: number
}
ChallengeType {
  type: 'image/png' | 'text/plain' | 'chain/<chainTicker>'
  //...other properties for more complex types later, e.g. an array of whitelisted addresses, a token address, etc,
}
Multisub /* (IPNS record Multisub.address) (not yet implemented) */ {
  title?: string
  description?: string
  communities: MultisubCommunity[]
  createdAt: number
  updatedAt: number
  signature: Signature // signature of the Multisub update by the multisub owner to protect against malicious gateway
}
MultisubCommunity { // (not yet implemented) this metadata is set by the owner of the Multisub, not the owner of the community
  address: Address
  title?: string
  description?: string
  languages?: string[] // client can detect language and hide/show community based on it
  locations?: string[] // client can detect location and hide/show community based on it
  features?: string[] // client can detect user's SFW setting and hide/show community based on it
  tags?: string[] // arbitrary keywords used for search
}
PKCDefaults { // fetched once when app first load, a dictionary of default settings (not yet implemented)
  multisubAddresses: {[multisubName: string]: Address}
  // PKC has 3 default multisubs
  multisubAddresses.all: Address // the default communities to show at url pkc.bso/p/all
  multisubAddresses.crypto: Address // the communities to show at url pkc.bso/p/crypto
  multisubAddresses.search: Address // list of thousands of semi-curated communities to "search" for in the client (only search the Multisub metadata, don't load each community)
}
```

### Pubsub message types

```js
PubsubMessage: {
  type: 'CHALLENGEREQUEST' | 'CHALLENGE' | 'CHALLENGEANSWER' | 'CHALLENGEVERIFICATION'
  challengeRequestId: Uint8Array // (byte string in cbor) // multihash of challengeRequestMessage.signature.publicKey, each challengeRequestMessage must use a new public key
  timestamp: number // in seconds, needed because publication.timestamp is encrypted
  signature: PubsubSignature // each challengeRequestMessage must use a new public key
  protocolVersion: '1.0.0' // semantic version of the protocol https://semver.org/
  userAgent: `/pkc-js:${require('./package.json').version}/` // client name and version using this standard https://en.bitcoin.it/wiki/BIP_0014#Proposal
}
ChallengeRequestMessage extends PubsubMessage /* (sent by post author) */ {
  acceptedChallengeTypes: string[] // list of challenge types the client can do, for example cli clients or old clients won't do all types
  encrypted: Encrypted
  /* ChallengeRequestMessage.encrypted.ciphertext decrypts to JSON {
    comment?: Comment
    vote?: Vote
    commentEdit?: CommentEdit
    commentModeration?: CommentModeration
    communityEdit?: CommunityEdit
    challengeAnswers?: string[] // some challenges might be included in community.challenges and can be pre-answered
    challengeCommentCids?: string[] // some challenges could require including comment cids in other communities, like friendly community karma challenges
  }
  pkc-js should decrypt the encrypted fields when possible, and add `ChallengeRequestMessage.publication` property for convenience (not part of the broadcasted pubsub message) */
}
ChallengeMessage extends PubsubMessage /* (sent by community owner) */ {
  encrypted: Encrypted
  /* ChallengeMessage.encrypted.ciphertext decrypts to JSON {
    challenges: Challenge[]
  }
  pkc-js should decrypt the encrypted fields when possible, and add `ChallengeMessage.challenges` property for convenience (not part of the broadcasted pubsub message) */
}
ChallengeAnswerMessage extends PubsubMessage /* (sent by post author) */ {
  encrypted: Encrypted
  /* ChallengeAnswerMessage.encrypted.ciphertext decrypts to JSON {
    challengeAnswers: string[] // for example ['2+2=4', '1+7=8']
  }
  pkc-js should decrypt the encrypted fields when possible, and add `ChallengeAnswerMessage.challengeAnswers` property for convenience (not part of the broadcasted pubsub message) */
}
ChallengeVerificationMessage extends PubsubMessage /* (sent by community owner) */ {
  challengeSuccess: bool // true if the challenge was successfully completed by the requester
  challengeErrors?: {[challengeIndex: string]: string} // challenge index => challenge error, tell the user which challenge failed and why
  reason?: string // reason for failed verification, for example post content is too long. could also be used for successful verification that bypass the challenge, for example because an author has good history
  encrypted: Encrypted
  /* ChallengeVerificationMessage.encrypted.ciphertext decrypts to JSON {
    comment?: Comment // must contain missing props from comment publication, like depth, postCid, etc
    commentUpdate?: CommentUpdate // must contain commentUpdate.cid and commentUpdate.signature when publication is comment
  }
  pkc-js should decrypt the encrypted fields when possible, and add `ChallengeVerificationMessage.publication` property for convenience (not part of the broadcasted pubsub message) */
}
Challenge {
  type: 'image/png' | 'text/plain' | 'chain/<chainTicker>' // tells the client how to display the challenge, start with implementing image and text only first
  challenge: string // base64 or utf8 required to complete the challenge, could be html, png, etc.
  caseInsensitive?: boolean // challenge answer capitalization is ignored, informational only option added by the challenge file
}
Encrypted {
  // examples available at https://github.com/pkcprotocol/pkc-js/blob/master/docs/encryption.md
  ciphertext: Uint8Array // (byte string in cbor) encrypted byte string with AES GCM 128 // https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation#Galois/counter_(GCM)
  iv: Uint8Array // (byte string in cbor) iv for the AES GCM 128 encrypted content
  tag: Uint8Array // (byte string in cbor) authentication tag, AES GCM has authentication tag https://en.wikipedia.org/wiki/Galois/Counter_Mode
  type: 'ed25519-aes-gcm'
}
PubsubSignature {
  signature: Uint8Array // (byte string in cbor)
  publicKey: Uint8Array // (byte string in cbor) 32 bytes
  type: 'ed25519' | 'eip191' // multiple versions/types to allow signing with metamask/other wallet or to change the signature fields or algorithm
  signedPropertyNames: string[] // the fields that were signed as part of the signature e.g. ['title', 'content', 'author', etc.] client should require that certain fields be signed or reject the publication, e.g. 'content', 'author', 'timestamp' are essential
}
```

### Libraries that use pkc-js

- [bitsocial-cli](https://github.com/bitsocialnet/bitsocial-cli) - CLI client for the Bitsocial protocol
- [bitsocial-react-hooks](https://github.com/bitsocialnet/bitsocial-react-hooks) - React hooks for building Bitsocial protocol UIs
- [bso-resolver](https://github.com/bitsocialnet/bso-resolver) - Resolves .bso human readable names to PKC cryptographic identities

# API

- [PKC API](#pkc-api)
  - [`PKC(pkcOptions)`](#pkcpkcoptions)
  - [`pkc.getMultisub(multisubAddress)`](#pkcgetmultisubmultisubaddress) *(not yet implemented)*
  - [`pkc.getCommunity({address})`](#pkcgetcommunityaddress)
  - [`pkc.getComment({cid})`](#pkcgetcommentcid)
  - [`pkc.createMultisub(createMultisubOptions)`](#pkccreatemultisubcreatemultisuboptions) *(not yet implemented)*
  - [`pkc.createCommunity(createCommunityOptions)`](#pkccreatecommunitycreatecommunityoptions)
  - [`pkc.createCommunityEdit(createCommunityEditOptions)`](#pkccreatecommunityeditcreatecommunityeditoptions)
  - [`pkc.createComment(createCommentOptions)`](#pkccreatecommentcreatecommentoptions)
  - [`pkc.createCommentEdit(createCommentEditOptions)`](#pkccreatecommenteditcreatecommenteditoptions)
  - [`pkc.createCommentModeration(createCommentModerationOptions)`](#pkccreatecommentmoderationcreatecommentmoderationoptions)
  - [`pkc.createVote(createVoteOptions)`](#pkccreatevotecreatevoteoptions)
  - [`pkc.createSigner(createSignerOptions)`](#pkccreatesignercreatesigneroptions)
  - `pkc.communities`
  - `pkc.clients`
  - [`pkc.getDefaults()`](#pkcgetdefaults) *(not yet implemented)*
  - `pkc.fetchCid({cid})`
  - `pkc.resolveAuthorAddress({address})`
  - `PKC.getShortAddress({address})`
  - `PKC.getShortCid({cid})`
  - `PKC.setNativeFunctions(nativeFunctions)`
  - `PKC.nativeFunctions`
  - `PKC.challenges`
- [PKC Events](#pkc-events)
  - [`communitieschange`](#communitieschange)
  - `error`
- [Community API](#community-api)
  - [`community.edit(communityEditOptions)`](#communityeditcommunityeditoptions)
  - [`community.start()`](#communitystart)
  - [`community.stop()`](#communitystop)
  - [`community.update()`](#communityupdate)
  - `community.delete()`
  - `community.address`
  - `community.shortAddress`
  - `community.roles`
  - `community.posts`
  - `community.lastPostCid`
  - `community.pubsubTopic`
  - `community.rules`
  - `community.flairs`
  - `community.suggested`
  - `community.features`
  - `community.settings`
  - `community.createdAt`
  - `community.updatedAt`
  - `community.statsCid`
  - `community.updateCid`
  - `community.signer`
  - `community.started`
  - `community.state`
  - `community.updatingState`
  - `community.startedState`
- [Community Events](#community-events)
  - [`update`](#update)
  - [`challengerequest`](#challengerequest)
  - [`challengeanswer`](#challengeanswer)
  - `challenge`
  - `challengeverification`
  - `error`
  - [`statechange`](#statechange)
  - [`updatingstatechange`](#updatingstatechange)
  - [`startedstatechange`](#startedstatechange)
- [Comment API](#comment-api)
  - [`comment.publish()`](#commentpublish)
  - [`comment.publishChallengeAnswers()`](#commentpublishchallengeanswerschallengeanswers)
  - [`comment.update()`](#commentupdate)
  - [`comment.stop()`](#commentstop)
  - `comment.author`
  - `comment.timestamp`
  - `comment.signature`
  - `comment.previousCid`
  - `comment.postCid`
  - `comment.parentCid`
  - `comment.communityAddress`
  - `comment.shortCommunityAddress`
  - `comment.title`
  - `comment.content`
  - `comment.link`
  - `comment.linkWidth`
  - `comment.linkHeight`
  - `comment.thumbnailUrl`
  - `comment.thumbnailUrlWidth`
  - `comment.thumbnailUrlHeight`
  - `comment.flairs`
  - `comment.spoiler`
  - `comment.depth`
  - `comment.state`
  - `comment.updatingState`
  - `comment.publishingState`
  - `(only available after challengeverification event)`
  - `comment.cid`
  - `comment.shortCid`
  - `(only available after first update event)`
  - `comment.edit`
  - `comment.original`
  - `comment.upvoteCount`
  - `comment.downvoteCount`
  - `comment.updatedAt`
  - `comment.pinned`
  - `comment.deleted`
  - `comment.removed`
  - `comment.locked`
  - `comment.reason`
  - `comment.replies`
  - `comment.replyCount`
- [Comment Events](#comment-events)
  - [`update`](#update)
  - [`challenge`](#challenge)
  - [`challengeverification`](#challengeverification)
  - `challengerequest`
  - `challengeanswer`
  - `error`
  - [`statechange`](#statechange-1)
  - [`updatingstatechange`](#updatingstatechange-1)
  - [`publishingstatechange`](#publishingstatechange)
- [Pages API](#pages-api)
  - [`pages.getPage({cid})`](#pagesgetpagecid)
  - `pages.pages`
  - `pages.pageCids`
- Client API
  - `client.state`
  - `client.settings`
  - `client.setSettings(pkcRpcSettings)`
  - `client.rpcCall(method, params)`
  - `client.getPeers()`
  - `client.getStats()`
- [Client Events](#client-events)
  - [`statechange`](#statechange-2)
  - [`settingschange`](#settingschange)

## PKC API
The PKC API for reading and writing to and from communities.

### `PKC(pkcOptions)`

> Create a PKC instance.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| pkcOptions | `PKCOptions` | Options for the PKC instance |

##### PKCOptions

An object which may have the following keys:

| Name | Type | Default | Description |
| ---- | ---- | ------- | ----------- |
| ipfsGatewayUrls | `strings[]` or `undefined` | `['https://cloudflare-ipfs.com']` | Optional URLs of IPFS gateways |
| kuboRpcClientsOptions | `(string \| kuboRpcClientsOptions)[]` or `undefined` | `undefined` | Optional URLs of Kubo IPFS APIs or [kuboRpcClientsOptions](https://www.npmjs.com/package/kubo-rpc-client#options), `'http://localhost:5001/api/v0'` to use a local Kubo IPFS node |
| pubsubKuboRpcClientsOptions | `(string \| kuboRpcClientsOptions)[]` or `undefined` | `['https://pubsubprovider.xyz/api/v0']` | Optional URLs or [kuboRpcClientsOptions](https://www.npmjs.com/package/kubo-rpc-client#options) used for pubsub publishing when `kuboRpcClientsOptions` isn't available, like in the browser |
| pkcRpcClientsOptions | `string[]` or `undefined` | `undefined` | Optional websocket URLs of PKC RPC servers, required to run a community from a browser/electron/webview |
| dataPath | `string`  or `undefined` | .pkc folder in the current working directory | (Node only) Optional folder path to create/resume the user and community databases |
| resolveAuthorNames | `boolean`  or `undefined` | `true` | Optionally disable resolving crypto domain author names, which can be done lazily later to save time |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<PKC>` | A `PKC` instance |

#### Example

```js
const PKC = require('@pkcprotocol/pkc-js')
const options = {
  ipfsGatewayUrls: ['https://cloudflare-ipfs.com'],
  kuboRpcClientsOptions: ['http://localhost:5001/api/v0'], // optional, must run an IPFS node to use localhost:5001/api/v0
  dataPath: __dirname
}
const pkc = await PKC(options) // should be independent instance, not singleton
pkc.on('error', console.log)
```

### `pkc.getMultisub(multisubAddress)` *(not yet implemented)*

> Get a multisub by its `Address`. A multisub is a list of communities curated by the creator of the multisub. E.g. `'pkc.bso/#/m/john.bso'` would display a feed of the multisub communities curated by `'john.bso'` (multisub `Address` `'john.bso'`).

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| multisubAddress | `string` | The `Address` of the multisub |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Multisub>` | A `Multisub` instance. |

#### Example

```js
const multisubAddress = '12D3KooW...' // or 'john.bso'
const multisub = await pkc.getCommunity({address: multisubAddress})
const multisubCommunityAddresses = multisub.map(community => community.address)
console.log(multisubCommunityAddresses)
```

### `pkc.getCommunity({address})`

> Get a community by its `Address`.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| address | `string` | The `Address` of the community |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Community>` | A `Community` instance. |

#### Example

```js
const communityAddress = '12D3KooW...'
const community = await pkc.getCommunity({address: communityAddress})
console.log(community)

let currentPostCid = community.lastPostCid
const scrollAllCommunityPosts = async () => {
  while (currentPostCid) {
    const post = await pkc.getComment({cid: currentPostCid})
    console.log(post)
    currentPostCid = post.previousCid
  }
  console.log('there are no more posts')
}
scrollAllCommunityPosts()
/*
Prints:
{ ...TODO }
*/
```

### `pkc.getComment({cid})`

> Get a PKC comment by its IPFS CID. Posts are also comments.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| cid | `string` | The IPFS CID of the comment |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Comment>` | A `Comment` instance |

#### Example

```js
const commentCid = 'Qm...'
const comment = await pkc.getComment({cid: commentCid})
console.log('comment:', comment)
comment.on('update', updatedComment => console.log('comment with latest data', updatedComment))
if (comment.parentCid) { // comment with no parent cid is a post
  pkc.getComment({cid: comment.parentCid}).then(parentPost => console.log('parent post:', parentPost))
}
pkc.getCommunity({address: comment.communityAddress}).then(community => console.log('community:', community))
pkc.getComment({cid: comment.previousCid}).then(previousComment => console.log('previous comment:', previousComment))
/*
Prints:
{ ...TODO }
*/
```

### `pkc.createMultisub(createMultisubOptions)` *(not yet implemented)*

> Create a multisub instance. A multisub is a list of communities curated by the creator of the multisub. E.g. `'pkc.bso/#/m/john.bso'` would display a feed of the multisub communities curated by `'john.bso'` (multisub `Address` `'john.bso'`).

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createMultisubOptions | `CreateMultisubOptions` | Options for the `Multisub` instance |

##### CreateMultisubOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| address | `string` or `undefined` | `Address` of the multisub |
| signer | `Signer` or `undefined` | (Multisub owners only) Optional `Signer` of the community to create a multisub with a specific private key |
| title | `string` or `undefined` | Title of the multisub |
| description | `string` or `undefined` | Description of the multisub |
| communities | `MultisubCommunity[]` or `undefined` | List of `MultisubCommunity` of the multisub |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Multisub>` | A `Multisub` instance |

#### Example

```js
const multisubOptions = {signer}
const multisub = await pkc.createMultisub(multisubOptions)

// edit the multisub info in the database (only in Node and if multisub.signer is defined)
await multisub.edit({
  address: 'funny-communities.bso',
  title: 'Funny communities',
  description: 'The funniest communities',
})

// add a list of communities to the multisub in the database (only in Node and if multisub.signer is defined)
const multisubCommunity1 = {address: 'funny.bso', title: 'Funny things', tags: ['funny']}
const multisubCommunity2 = {address: 'even-more-funny.bso'}
await multisub.edit({communities: [multisubCommunity1, multisubCommunity2]})

// start publishing updates to your multisub (only in Node and if multisub.signer is defined)
await multisub.start()

// stop publishing updates to your multisub
await multisub.stop()
```

### `pkc.createCommunity(createCommunityOptions)`

> Create a community instance. Should update itself on update events after `Community.update()` is called if `CreateCommunityOptions.address` exists. If the community database corresponding to `community.address` exists locally, can call `Community.edit(communityEditOptions)` to edit the community as the owner, and `Community.start()` to listen for new posts on the pubsub and publish updates as the owner.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createCommunityOptions | `CreateCommunityOptions` | Options for the `Community` instance |

##### CreateCommunityOptions

An object which may have the following keys:

| Name | Type | Default | Description |
| ---- | ---- | ------- | ----------- |
| address | `string` or `undefined` | `undefined` | `Address` of the community |
| signer | `Signer` or `undefined` | `undefined` | (Community owners only) Optional `Signer` of the community to create a community with a specific private key |
| ...community | `any` | `undefined` | `CreateCommunityOptions` can also initialize any property on the `Community` instance |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Community>` | A `Community` instance |

#### Example

```js
const PKC = require('@pkcprotocol/pkc-js')
const pkcOptions = {
  ipfsGatewayUrls: ['https://cloudflare-ipfs.com'],
  kuboRpcClientsOptions: ['http://localhost:5001/api/v0'], // optional, must run an IPFS node to use localhost:5001/api/v0
  dataPath: __dirname
}
const pkc = await PKC(pkcOptions)
pkc.on('error', console.log)

// create a new local community as the owner
const community = await pkc.createCommunity()

// create a new local community as the owner, already with settings
const community = await pkc.createCommunity({title: 'Memes', description: 'Post your memes here.'})

// create a new local community as the owner with a premade signer
const signer = await pkc.createSigner()
const community = await pkc.createCommunity({signer})
// signer.address === community.address

// create a new local community as the owner with a premade signer, already with settings
const signer = await pkc.createSigner()
const community = await pkc.createCommunity({signer, title: 'Memes', description: 'Post your memes here.'})

// instantiate an already existing community instance
const communityOptions = {address: '12D3KooW...',}
const community = await pkc.createCommunity(communityOptions)

// edit the community info in the database
await community.edit({
  title: 'Memes',
  description: 'Post your memes here.',
  pubsubTopic: '12D3KooW...'
})

// start publishing updates every 5 minutes
await community.start()

// instantiate an already existing community instance and initialize any property on it
const community = await pkc.createCommunity({
  address: '12D3KooW...',
  title: 'Memes',
  posts: {
    pages: {
      hot: {
        nextCid: 'Qm...',
        comments: [{content: 'My first post', ...post}]
      }
    },
    pageCids: {topAll: 'Qm...', new: 'Qm...', ...pageCids}
  }
})
console.log(community.title) // prints 'Memes'
console.log(community.posts.pages.hot.comments[0].content) // prints 'My first post'
```

### `pkc.createCommunityEdit(createCommunityEditOptions)`

> Create a `CommunityEdit` instance, which can be used by admins to edit a community remotely over pubsub. A `CommunityEdit` is a regular `Publication` and must still be published and go through a challenge handshake.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createCommunityEditOptions | `CreateCommunityEditOptions` | The community edit to create, extends [`CommunityEditOptions`](#communityeditoptions) |

##### CreateCommunityEditOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| address | `string` | `Address` of the community to edit |
| timestamp | `number` or `undefined` | Time of publishing in seconds, `Math.round(Date.now() / 1000)` if undefined |
| author | `Author` | `author.address` of the community edit must have `community.roles` `'admin'` |
| signer | `Signer` | Signer of the community edit |
| ...communityEditOptions | `any` | `CreateCommunityEditOptions` extends [`CommunityEditOptions`](#communityeditoptions) |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<CommunityEdit>` | A `CommunityEdit` instance |

#### Example

```js
const createCommunityEditOptions = {address: 'news.bso', title: 'New title'}
const communityEdit = await pkc.createCommunityEdit(createCommunityEditOptions)
communityEdit.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  communityEdit.publishChallengeAnswers(challengeAnswers)
})
communityEdit.on('challengeverification', console.log)
await communityEdit.publish()
```

### `pkc.createComment(createCommentOptions)`

> Create a `Comment` instance. Posts/Replies are also comments. Should update itself on update events after `Comment.update()` is called if `CreateCommentOptions.cid` exists.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createCommentOptions | `CreateCommentOptions` | The comment to create |

##### CreateCommentOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| communityAddress | `string` or `undefined` | `Address` of the community (derived from `communityName` or `communityPublicKey` if not provided) |
| communityPublicKey | `string` or `undefined` | IPNS public key of the community (can identify the community instead of `communityAddress`) |
| communityName | `string` or `undefined` | Domain name of the community, e.g. `'memes.bso'` (can identify the community instead of `communityAddress`) |
| timestamp | `number` or `undefined` | Time of publishing in seconds, `Math.round(Date.now() / 1000)` if undefined |
| author | `Author` | Author of the comment |
| signer | `Signer` | Signer of the comment |
| parentCid | `string` or `undefined` | The parent comment CID, undefined if comment is a post, same as postCid if comment is top level |
| content | `string` or `undefined` | Content of the comment, link posts have no content |
| title | `string` or `undefined` | If comment is a post, it needs a title |
| link | `string` or `undefined` | If comment is a post, it might be a link post |
| spoiler | `boolean` or `undefined` | Hide the comment thumbnail behind spoiler warning |
| flairs | `Flair[]` or `undefined` | Author or mod chosen colored labels for the comment |
| challengeRequest | `ChallengeRequest` or `undefined` | Optional properties to pass to `ChallengeRequestPubsubMessage` |
| cid | `string` or `undefined` | (Not for publishing) Gives access to `Comment.on('update')` for a comment already fetched |
| ...comment | `any` | `CreateCommentOptions` can also initialize any property on the `Comment` instance |

##### ChallengeRequest

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| challengeAnswers | `string[]` or `undefined` | Optional pre-answers to community.challenges |
| challengeCommentCids | `string[]` or `undefined` | Optional comment cids for community.challenges related to author karma/age in other communities |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Comment>` | A `Comment` instance |

#### Example

```js
const comment = await pkc.createComment(createCommentOptions)
comment.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  comment.publishChallengeAnswers(challengeAnswers)
})
comment.on('challengeverification', console.log)
await comment.publish()

// initialize any property on the Comment instance
const comment = await pkc.createComment({
  cid: 'Qm...',
  content: 'My first post',
  locked: true,
  upvoteCount: 100,
  replies: {
    pages: {
      best: {
        nextCid: 'Qm...',
        comments: [{content: 'My first reply', ...reply}]
      }
    },
    pageCids: {new: 'Qm...', old: 'Qm...', ...pageCids}
  }
})
console.log(comment.content) // prints 'My first post'
console.log(comment.locked) // prints true
console.log(comment.upvoteCount) // prints 100
console.log(comment.replies.pages.best.comments[0].content) // prints 'My first reply'
```

### `pkc.createCommentEdit(createCommentEditOptions)`

> Create a `CommentEdit` instance, which can be used by authors to edit their own comments. A `CommentEdit` must still be published and go through a challenge handshake.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createCommentEditOptions | `CreateCommentEditOptions` | The comment edit to create |

##### CreateCommentEditOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| communityAddress | `string` or `undefined` | `Address` of the community (derived from `communityName` or `communityPublicKey` if not provided) |
| commentCid | `string` | The comment CID to be edited (don't use 'cid' because eventually CommentEdit.cid will exist) |
| timestamp | `number` or `undefined` | Time of publishing in ms, `Math.round(Date.now() / 1000)` if undefined |
| author | `Author` | Author of the `CommentEdit` publication, must be original author. Not used to edit the `comment.author` property, only to authenticate the `CommentEdit` publication |
| signer | `Signer` | Signer of the edit, must be original author |
| content | `string` or `undefined` | Edited content of the comment |
| deleted | `boolean` or `undefined` | Edited deleted status of the comment |
| flairs | `Flair[]` or `undefined` | Edited flairs of the comment |
| spoiler | `boolean` or `undefined` | Edited spoiler of the comment |
| reason | `string` or `undefined` | Reason of the edit |
| challengeRequest | `ChallengeRequest` or `undefined` | Optional properties to pass to `ChallengeRequestPubsubMessage` |

##### ChallengeRequest

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| challengeAnswers | `string[]` or `undefined` | Optional pre-answers to community.challenges |
| challengeCommentCids | `string[]` or `undefined` | Optional comment cids for community.challenges related to author karma/age in other communities |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<CommentEdit>` | A `CommentEdit` instance |

#### Example

```js
const commentEdit = await pkc.createCommentEdit(createCommentEditOptions)
commentEdit.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  commentEdit.publishChallengeAnswers(challengeAnswers)
})
commentEdit.on('challengeverification', console.log)
await commentEdit.publish()
```

### `pkc.createCommentModeration(createCommentModerationOptions)`

> Create a `CommentModeration` instance, which can be used by moderators to remove comments. A `CommentModeration` must still be published and go through a challenge handshake.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createCommentModerationOptions | `CreateCommentModerationOptions` | The comment moderation to create |

##### CreateCommentModerationOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| communityAddress | `string` or `undefined` | `Address` of the community (derived from `communityName` or `communityPublicKey` if not provided) |
| commentCid | `string` | The comment CID to be edited (don't use 'cid' because eventually CommentEdit.cid will exist) |
| timestamp | `number` or `undefined` | Time of publishing in ms, `Math.round(Date.now() / 1000)` if undefined |
| author | `Author` | Author of the `CommentModeration` publication, must be moderator. Not used to edit the `comment.author` property, only to authenticate the `CommentModeration` publication |
| signer | `Signer` | Signer of the edit, must be moderator |
| commentModeration | `CommentModerationOptions` | The comment moderation options |
| challengeRequest | `ChallengeRequest` or `undefined` | Optional properties to pass to `ChallengeRequestPubsubMessage` |

##### CommentModerationOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| flairs | `Flair[]` or `undefined` | Edited flairs of the comment |
| spoiler | `boolean` or `undefined` | Edited spoiler of the comment |
| nsfw | `boolean` or `undefined` | Edited nsfw status of the comment |
| reason | `string` or `undefined` | Reason of the edit |
| pinned | `boolean` or `undefined` | Edited pinned status of the comment |
| locked | `boolean` or `undefined` | Edited locked status of the comment |
| archived | `boolean` or `undefined` | Edited archived status of the comment |
| approved | `boolean` or `undefined` | Approving a comment that's pending approval |
| removed | `boolean` or `undefined` | Edited removed status of the comment |
| purged | `boolean` or `undefined` | Purged status of the comment |
| author | `CommentModerationAuthorOptions` or `undefined` | Edited author property of the comment |

##### CommentModerationAuthorOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| banExpiresAt | `number` or `undefined` | Comment author was banned for this comment |
| flairs | `Flair[]` or `undefined` | Edited flairs of the comment author |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<CommentModeration>` | A `CommentModeration` instance |

#### Example

```js
const commentModeration = await pkc.createCommentModeration(createCommentModerationOptions)
commentModeration.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  commentModeration.publishChallengeAnswers(challengeAnswers)
})
commentModeration.on('challengeverification', console.log)
await commentModeration.publish()
```

### `pkc.createVote(createVoteOptions)`

> Create a `Vote` instance. `Vote` inherits from `Publication`, like `Comment`, so has the same API.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createVoteOptions | `CreateVoteOptions` | The vote to create |

##### CreateVoteOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| communityAddress | `string` or `undefined` | `Address` of the community (derived from `communityName` or `communityPublicKey` if not provided) |
| commentCid | `string` | The comment or post to vote on |
| timestamp | `number` or `undefined` | Time of publishing in ms, `Math.round(Date.now() / 1000)` if undefined |
| author | `Author` | Author of the comment, will be needed for voting with NFTs or tokens |
| vote | `1` or `0` or `-1` | 0 is for resetting a vote |
| signer | `Signer` | Signer of the vote |
| challengeRequest | `ChallengeRequest` or `undefined` | Optional properties to pass to `ChallengeRequestPubsubMessage` |

##### ChallengeRequest

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| challengeAnswers | `string[]` or `undefined` | Optional pre-answers to community.challenges |
| challengeCommentCids | `string[]` or `undefined` | Optional comment cids for community.challenges related to author karma/age in other communities |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Vote>` | A `Vote` instance |

#### Example

```js
const vote = await pkc.createVote(createVoteOptions)
vote.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  vote.publishChallengeAnswers(challengeAnswers)
})
vote.on('challengeverification', console.log)
await vote.publish()
```

### `pkc.createSigner(createSignerOptions)`

> Create a `Signer` instance to be used in `CreateCommentOptions`.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| createSignerOptions | `CreateSignerOptions` or `undefined` | The options of the signer |

##### CreateSignerOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| privateKey | `string` or `undefined` | If undefined, generate a random `privateKey` |
| type | `string` | Required if `privateKey` defined, only `'ed25519'` for now |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Signer>` | A `Signer` instance |

#### Example

```js
const newRandomSigner = await pkc.createSigner()
const signerFromPrivateKey = await pkc.createSigner({privateKey: 'AbCd...', type: 'ed25519'})
```

### `pkc.communities`

> A `string[]` of community addresses stored locally. Updates when communities are created or deleted. Listen for changes with the `communitieschange` event.

#### Example

```js
// start all the communities you own and have stored locally
for (const address of pkc.communities) {
  const community = await pkc.createCommunity({address})
  await community.start()
}
```

### `pkc.getDefaults()` *(not yet implemented)*

> Get the default global PKC settings, e.g. the default multisubs like p/all, p/dao, etc.

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<PKCDefaults>` | A `PKCDefaults` instance. |

#### Example

```js
const pkcDefaults = await pkc.getDefaults()
const allMultisub = await pkc.getMultisub(pkcDefaults.multisubAddresses.all)
const allCommunityAddresses = allMultisub.map(community => community.address)
console.log(allCommunityAddresses)
```

## PKC Events
The PKC events.

### `communitieschange`

> `PKC.communities` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `string[]` | The `PKC.communities` property |

## Community API
The community API for getting community updates, or creating, editing, running a community as an owner.

### `community.edit(communityEditOptions)`

> Edit the content/information of a community in your local database. Only usable if the community database corresponding to `community.address` exists locally  (ie. you are the community owner).

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| community | `CommunityEditOptions` | The content/information of the community |

##### CommunityEditOptions

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| address | `string` or `undefined` | Address of the community, used to add a crypto domain |
| signer | `Signer` or `undefined` | Signer of the community, useful to change the private if the owner gets hacked, but still has his crypto domain
| title | `string` or `undefined` | Title of the community |
| description | `string` or `undefined` | Description of the community |
| roles | `{[authorAddress: string]: CommunityRole}` or `undefined` | Author addresses of the moderators |
| lastPostCid | `string` or `undefined` | The most recent post in the linked list of posts |
| posts | `Pages` or `undefined` | Only preload page 1 sorted by 'hot', might preload more later, should include some child comments and vote counts for each post |
| pubsubTopic | `string` or `undefined` | The string to publish to in the pubsub, a public key of the community owner's choice |
| features | `CommunityFeatures` or `undefined` | The features of the community |
| suggested | `CommunitySuggested` or `undefined` | The suggested client settings for the community |
| flairs | `{[key: 'post' or 'author']: Flair[]}` or `undefined` | The list of flairs (colored labels for comments or authors) authors or mods can choose from |
| settings | `CommunitySettings` or `undefined` | The private community.settings property of the community, not shared in the community IPNS |

##### CommunitySettings

An object which may have the following keys:

| Name | Type | Description |
| ---- | ---- | ----------- |
| fetchThumbnailUrls | `boolean` or `undefined` | Fetch the thumbnail URLs of comments `comment.link` property, could reveal the IP address of the community node |
| fetchThumbnailUrlsProxyUrl | `string` or `undefined` | The HTTP proxy URL used to fetch thumbnail URLs |

#### Example

```js
// TODO
```

### `community.start()`

> Start listening for new posts on the pubsub, and publishing them every 5 minutes. Only usable if the community database corresponding to `community.address` exists locally  (ie. you are the community owner).

#### Example

```js
const options = {
  title: 'Your community title'
}
const community = await pkc.createCommunity(options)
// edit the community info in the database
await community.edit({
  title: 'Memes',
  description: 'Post your memes here.',
  pubsubTopic: '12D3KooW...'
})
// start publishing updates/new posts
await community.start()
```

### `community.stop()`

> Stop polling the network for new community updates started by community.update(). Also stop listening for new posts on the pubsub started by community.start(), and stop publishing them every 5 minutes.

### `community.update()`

> Start polling the network for new posts published in the community, update itself and emit the 'update' event. Only usable if community.address exists.

#### Example

```js
const options = {
  address: '12D3KooW...'
}
const community = await pkc.createCommunity(options)
community.on('update', (updatedCommunityInstance) => {
  console.log(updatedCommunityInstance)

  // if you want to stop polling for new updates after only the first one
  community.stop()
})
community.update()
```

## Community Events
The community events.

### `update`

> The community's IPNS record has been updated, which means new posts may have been published.

#### Emits

| Type | Description |
| -------- | -------- |
| `Community` | The updated `Community` instance (the instance emits itself), i.e. `this` |

#### Example

```js
const options = {
  address: '12D3KooW...'
}
const community = await pkc.createCommunity(options)
community.on('update', (updatedCommunity) => console.log(updatedCommunity))
community.update()

// stop updating in 10 minutes
setTimeout(() => community.stop(), 60000)
```

### `challengerequest`

> When the user publishes a comment, he makes a `'challengerequest'` to the pubsub, the community owner will send back a `challenge`, eg. a captcha that the user must complete.

#### Emits

| Type | Description |
| -------- | -------- |
| `ChallengeRequestMessage` | The comment of the user and the challenge request |

Object is of the form:

```js
{ // ...TODO }
```

#### Example

```js
{ // ...TODO }
```

### `challengeanswer`

> After receiving a `Challenge`, the user owner will send back a `challengeanswer`.

#### Emits

| Type | Description |
| -------- | -------- |
| `ChallengeAnswerMessage` | The challenge answer |

Object is of the form:

```js
{ // ...TODO }
```

### `statechange`

> `Community.state` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `'stopped' \| 'updating' \| 'started'` | The `Community.state` property |

### `updatingstatechange`

> `Community.updatingState` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `'stopped' \| 'resolving-address' \| 'fetching-ipns' \| 'fetching-ipfs' \| 'failed' \| 'succeeded'` | The `Community.updatingState` property |

### `startedstatechange`

> `Community.startedState` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `'stopped' \| 'fetching-ipns' \| 'publishing-ipns' \| 'failed' \| 'succeeded'` | The `Community.startedState` property |

## Comment API
The comment API for publishing a comment as an author, or getting comment updates. `Comment`, `Vote` and `CommentEdit` inherit `Publication` class and all have a similar API. A `Comment` updates itselfs on update events after `Comment.update()` is called if `Comment.cid` exists.

### `comment.publish()`

> Publish the comment to the pubsub. You must then wait for the `'challenge'` event and answer with a `ChallengeAnswer`.

#### Example

```js
const comment = await pkc.createComment(commentObject)
comment.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  comment.publishChallengeAnswers(challengeAnswers)
})
comment.on('challengeverification', console.log)
await comment.publish()
```

### `comment.publishChallengeAnswers(challengeAnswers)`

> Publish your answers to the challenges e.g. the captcha answers.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| challengeAnswers | `string[]` | The challenge answers |

#### Example

```js
const comment = await pkc.createComment(commentObject)
comment.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  comment.publishChallengeAnswers(challengeAnswers)
})
comment.on('challengeverification', console.log)
await comment.publish()
```

### `comment.update()`

> Start polling the network for comment updates (replies, upvotes, edits, etc), update itself and emit the update event. Only usable if comment.cid or exists.

#### Example

```js
const commentCid = 'Qm...'
const comment = await pkc.getComment({cid: commentCid})
comment.on('update', (updatedCommentInstance) => {
  console.log(updatedCommentInstance)

  // if you want to stop polling for new updates after only the first one
  comment.stop()
})
comment.update()

// if you already fetched the comment and only want the updates
const commentDataFetchedEarlier = {content, author, cid, ...comment}
const comment = await pkc.createComment(commentDataFetchedEarlier)
comment.on('update', () => {
  console.log('the comment instance updated itself:', comment)
})
comment.update()
```

### `comment.stop()`

> Stop polling the network for new comment updates started by comment.update().

## Comment Events
The comment events.

### `update`

> The comment has been updated, which means vote counts and replies may have changed. To start polling the network for updates, call `Comment.update()`. If the previous `CommentUpdate` is the same, do not emit `update`.

#### Emits

| Type | Description |
| -------- | -------- |
| `Comment` | The updated `Comment`, i.e. itself, `this` |

Object is of the form:

```js
{ // ...TODO }
```

#### Example

```js
const comment = await pkc.getComment({cid: commentCid})
comment.on('update', (updatedComment) => {
  console.log(updatedComment)
})
comment.update()

// stop looking for updates after 10 minutes
setTimeout(() => comment.stop(), 60000)
```

### `challenge`

> After publishing a comment, the community owner will send back a `challenge`, eg. a captcha that the user must complete.

#### Emits

| Type | Description |
| -------- | -------- |
| `ChallengeMessage` | The challenge the user must complete |
| `Comment` | The `Comment` instance, i.e. `this` |

Object is of the form:

```js
{ // ...TODO }
```

#### Example

```js
const comment = await pkc.createComment(commentObject)
comment.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  comment.publishChallengeAnswers(challengeAnswers)
})
comment.on('challengeverification', console.log)
await comment.publish()
```

### `challengeverification`

> After publishing a challenge answer, the community owner will send back a `challengeverification` to let the network know if the challenge was completed successfully.

#### Emits

| Type | Description |
| -------- | -------- |
| `ChallengeVerificationMessage` | The challenge verification result |
| `Comment` or `undefined` | The `Comment` instance if the publication is a comment and the verification contains comment data, otherwise `undefined` |

Object is of the form:

```js
{ // ...TODO }
```

#### Example

```js
const comment = await pkc.createComment(commentObject)
comment.on('challenge', async (challengeMessage) => {
  const challengeAnswers = await askUserForChallengeAnswers(challengeMessage.challenges)
  comment.publishChallengeAnswers(challengeAnswers)
})
comment.on('challengeverification', (challengeVerification) => console.log('published post cid is', challengeVerification?.publication?.cid))
await comment.publish()
```

### `statechange`

> `Comment.state` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `'stopped' \| 'updating' \| 'publishing'` | The `Comment.state` property |

### `updatingstatechange`

> `Comment.updatingState` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `'stopped' \| 'resolving-author-address' \| 'fetching-ipfs' \| 'fetching-update-ipns' \| 'fetching-update-ipfs' \| 'failed' \| 'succeeded'` | The `Comment.updatingState` property |

### `publishingstatechange`

> `Comment.publishingState` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `'stopped' \| 'resolving-community-address' \| 'fetching-community-ipns' \| 'fetching-community-ipfs' \| 'publishing-challenge-request' \| 'waiting-challenge' \| 'waiting-challenge-answers' \| 'publishing-challenge-answer' \| 'waiting-challenge-verification' \| 'failed' \| 'succeeded'` | The `Comment.publishingState` property |

## Pages API
The pages API for scrolling pages of a community or replies to a post/comment. `Community.posts` and `Comment.replies` are `Pages` instances. `Community.posts.pages.hot` is a `Page` instance.

### `pages.getPage({cid})`

> Get a `Page` instance using an IPFS CID from `Pages.pageCids[sortType]`, e.g. `Community.posts.pageCids.hot` or `Comment.replies.pageCids.best`.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| cid | `string` | The IPFS CID of the page |

#### Returns

| Type | Description |
| -------- | -------- |
| `Promise<Page>` | A `Page` instance |

#### Example

```js
// get sorted posts in a community
const community = await pkc.getCommunity({address: communityAddress})
const pageSortedByTopYear = await community.posts.getPage({cid: community.posts.pageCids.topYear})
const postsSortedByTopYear = pageSortedByTopYear.comments
console.log(postsSortedByTopYear)

// get sorted replies to a post or comment
const post = await pkc.getComment({cid: commentCid})
post.on('update', async updatedPost => {
  let replies
  // try to get sorted replies by sort type 'new'
  // sorted replies pages are not always available, for example if the post only has a few replies
  if (updatedPost.replies?.pageCids?.new) {
    const repliesPageSortedByNew = await updatedPost.replies.getPage({cid: updatedPost.replies.pageCids.new})
    replies = repliesPageSortedByNew.comments
  }
  else {
    // the 'best' sort type is always preloaded by default on replies and can be used as fallback
    // on community.posts only 'hot' is preloaded by default
    replies = updatedPost.replies.pages.best.comments
  }
  console.log(replies)
})
```

## Client Events
The client events.

### `statechange`

> `Client.state` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `'stopped' \| 'resolving-author-address' \| 'fetching-ipfs' \| 'fetching-update-ipns' \| 'fetching-update-ipfs' \| 'resolving-community-address' \| 'fetching-community-ipns' \| 'fetching-community-ipfs' \| 'subscribing-pubsub' \| 'publishing-challenge-request' \| 'waiting-challenge' \| 'waiting-challenge-answers' \| 'publishing-challenge-answer' \| 'waiting-challenge-verification' \| 'connecting' \| 'connected'` | The `Client.state` property |

#### Example

```js
const onStateChange = (state) => console.log('client state changed:', state)
for (const clientUrl in clients?.ipfsGateways) {
  comment.clients?.ipfsGateways?.[clientUrl].on('statechange', onStateChange)
}
for (const clientUrl in clients?.ipfsClients) {
  comment.clients?.ipfsClients?.[clientUrl].on('statechange', onStateChange)
}
for (const clientUrl in clients?.pubsubClients) {
  comment.clients?.pubsubClients?.[clientUrl].on('statechange', onStateChange)
}
for (const chainTicker in clients?.chainProviders) {
  for (const clientUrl in clients?.chainProviders?.[chainTicker]) {
    comment.clients?.chainProviders?.[chainTicker]?.[clientUrl].on('statechange', onStateChange)
  }
}
```

### `settingschange`

> `Client.settings` property changed.

#### Emits

| Type | Description |
| -------- | -------- |
| `PKCRpcSettings` | The `Client.settings` property |
