// import EventEmitter from "events";

// const loadingTime = 10;
// export const simulateLoadingTime = () => new Promise((r) => setTimeout(r, loadingTime));

// // keep a list of created and edited owner communities
// // to reinitialize them with pkc.createCommunity()
// let createdOwnerCommunitys: any = {};
// let editedOwnerCommunitys: any = {};

// // reset the pkc-js global state in between tests
// export const resetPKCJsMock = () => {
//     createdOwnerCommunitys = {};
//     editedOwnerCommunitys = {};
// };
// export const debugPKCJsMock = () => {
//     console.log({ createdOwnerCommunitys, editedOwnerCommunitys });
// };

// export class PKC extends EventEmitter {
//     async resolveAuthorAddress(authorAddress: { address: string }) {}

//     async createSigner() {
//         return {
//             privateKey: "private key",
//             address: "address"
//         };
//     }

//     async createCommunity(createCommunityOptions: any) {
//         if (!createCommunityOptions) {
//             createCommunityOptions = {};
//         }

//         // no address provided so probably a user creating an owner community
//         if (!createCommunityOptions.address && !createdOwnerCommunitys[createCommunityOptions.address]) {
//             createCommunityOptions = { ...createCommunityOptions, address: "created community address" };
//             // createdCommunityAddresses.push('created community address')
//             createdOwnerCommunitys[createCommunityOptions.address] = { ...createCommunityOptions };
//         }
//         // only address provided, so could be a previously created owner community
//         // add props from previously created sub
//         else if (
//             createdOwnerCommunitys[createCommunityOptions.address] &&
//             JSON.stringify(Object.keys(createCommunityOptions)) === '["address"]'
//         ) {
//             for (const prop in createdOwnerCommunitys[createCommunityOptions.address]) {
//                 if (createdOwnerCommunitys[createCommunityOptions.address][prop]) {
//                     createCommunityOptions[prop] = createdOwnerCommunitys[createCommunityOptions.address][prop];
//                 }
//             }
//         }

//         // add edited props if owner community was edited in the past
//         if (editedOwnerCommunitys[createCommunityOptions.address]) {
//             for (const prop in editedOwnerCommunitys[createCommunityOptions.address]) {
//                 if (editedOwnerCommunitys[createCommunityOptions.address][prop]) {
//                     createCommunityOptions[prop] = editedOwnerCommunitys[createCommunityOptions.address][prop];
//                 }
//             }
//         }

//         return new Community(createCommunityOptions);
//     }

//     async getCommunity({address: communityAddress}: { address: string }) {
//         await simulateLoadingTime();
//         const createCommunityOptions = {
//             address: communityAddress
//         };
//         const community: any = new Community(createCommunityOptions);
//         community.title = community.address + " title";
//         const hotPageCid = community.address + " page cid hot";
//         community.posts.pages.hot = getCommentsPage(hotPageCid, community);
//         community.posts.pageCids = {
//             hot: hotPageCid,
//             topAll: community.address + " page cid topAll",
//             new: community.address + " page cid new",
//             active: community.address + " page cid active"
//         };
//         return community;
//     }

//     async listCommunitys() {
//         return ["list community address 1", "list community address 2", ...Object.keys(createdOwnerCommunitys)];
//     }

//     async createComment(createCommentOptions: any) {
//         return new Comment(createCommentOptions);
//     }

//     async getComment({cid: commentCid}: { cid: string }) {
//         await simulateLoadingTime();
//         const createCommentOptions = {
//             cid: commentCid,
//             ipnsName: commentCid + " ipns name",
//             // useComment() requires timestamp or will use account comment instead of comment from store
//             timestamp: 1670000000,
//             ...this.commentToGet(commentCid)
//         };
//         return new Comment(createCommentOptions);
//     }

//     // mock this method to get a comment with different content, timestamp, address, etc
//     commentToGet(commentCid?: string) {
//         return {
//             // content: 'mock some content'
//             // author: {address: 'mock some address'},
//             // timestamp: 1234
//         };
//     }

//     async createVote() {
//         return new Vote();
//     }

//     async createCommentEdit(createCommentEditOptions: any) {
//         return new CommentEdit(createCommentEditOptions);
//     }

//     async createCommunityEdit(createCommunityEditOptions: any) {
//         return new CommunityEdit(createCommunityEditOptions);
//     }

//     async fetchCid({cid}: { cid: string }) {
//         if (cid?.startsWith("statscid")) {
//             return JSON.stringify({ hourActiveUserCount: 1 });
//         }
//         throw Error(`pkc.fetchCid not implemented in pkc-js mock for cid '${cid}'`);
//     }

//     async pubsubSubscribe(communityAddress: string) {}
//     async pubsubUnsubscribe(communityAddress: string) {}
// }

// export class Pages {
//     pageCids: any = {};
//     pages: any = {};
//     community: any;
//     comment: any;

//     constructor(pagesOptions?: any) {
//         Object.defineProperty(this, "community", { value: pagesOptions?.community, enumerable: false });
//         Object.defineProperty(this, "comment", { value: pagesOptions?.comment, enumerable: false });
//     }

//     async getPage({cid: pageCid}: { cid: string }) {
//         // need to wait twice otherwise react renders too fast and fetches too many pages in advance
//         await simulateLoadingTime();
//         return getCommentsPage(pageCid, this.community);
//     }

//     async _fetchAndVerifyPage(pageCid: string) {
//         return this.getPage({cid: pageCid});
//     }
// }

// export class Community extends EventEmitter {
//     updateCalledTimes = 0;
//     updating = false;
//     firstUpdate = true;
//     address: string | undefined;
//     title: string | undefined;
//     description: string | undefined;
//     posts: Pages;
//     updatedAt: number | undefined;
//     statsCid: string | undefined;
//     state: string;
//     updatingState: string;

//     constructor(createCommunityOptions?: any) {
//         super();
//         this.address = createCommunityOptions?.address;
//         this.title = createCommunityOptions?.title;
//         this.description = createCommunityOptions?.description;
//         this.statsCid = "statscid";
//         this.state = "stopped";
//         this.updatingState = "stopped";

//         this.posts = new Pages({ community: this });

//         // add community.posts from createCommunityOptions
//         if (createCommunityOptions?.posts?.pages) {
//             this.posts.pages = createCommunityOptions?.posts?.pages;
//         }
//         if (createCommunityOptions?.posts?.pageCids) {
//             this.posts.pageCids = createCommunityOptions?.posts?.pageCids;
//         }

//         // only trigger a first update if argument is only ({address})
//         if (!createCommunityOptions?.address || Object.keys(createCommunityOptions).length !== 1) {
//             this.firstUpdate = false;
//         }
//     }

//     toJSONInternalRpc() {
//         return {
//             title: this.title,
//             description: this.description,
//             address: this.address,
//             statsCid: this.statsCid,
//             roles: this.roles,
//             posts: this.posts
//         };
//     }

//     toJSONIpfs() {
//         return this.toJSONInternalRpc();
//     }

//     async update() {
//         this.updateCalledTimes++;
//         if (this.updateCalledTimes > 1) {
//             throw Error(
//                 "with the current hooks, community.update() should be called maximum 1 times, this number might change if the hooks change and is only there to catch bugs, the real comment.update() can be called infinite times"
//             );
//         }
//         // is ipnsName is known, look for updates and emit updates immediately after creation
//         if (!this.address) {
//             throw Error(`can't update without community.address`);
//         }
//         // don't update twice
//         if (this.updating) {
//             return;
//         }
//         this.updating = true;

//         this.state = "updating";
//         this.updatingState = "fetching-ipns";
//         this.emit("statechange", "updating");
//         this.emit("updatingstatechange", "fetching-ipns");

//         simulateLoadingTime().then(() => {
//             this.simulateUpdateEvent();
//         });
//     }

//     async stop() {}

//     async start() {}

//     async delete() {
//         if (this.address) {
//             delete createdOwnerCommunitys[this.address];
//             delete editedOwnerCommunitys[this.address];
//         }
//     }

//     simulateUpdateEvent() {
//         if (this.firstUpdate) {
//             this.simulateFirstUpdateEvent();
//             return;
//         }

//         this.description = this.address + " description updated";
//         this.updatedAt = Math.floor(Date.now() / 1000);

//         this.updatingState = "succeeded";
//         this.emit("update", this);
//         this.emit("updatingstatechange", "succeeded");
//     }

//     // the first update event adds all the field from getCommunity
//     async simulateFirstUpdateEvent() {
//         this.firstUpdate = false;

//         this.title = this.address + " title";
//         const hotPageCid = this.address + " page cid hot";
//         this.posts.pages.hot = getCommentsPage(hotPageCid, this);
//         this.posts.pageCids = {
//             hot: hotPageCid,
//             best: this.address + " page cid best",
//             new: this.address + " page cid new",
//             active: this.address + " page cid active"
//         };

//         // simulate the ipns update
//         this.updatingState = "succeeded";
//         this.emit("update", this);
//         this.emit("updatingstatechange", "succeeded");

//         // simulate the next update
//         this.updatingState = "fetching-ipns";
//         this.emit("updatingstatechange", "fetching-ipns");
//         simulateLoadingTime().then(() => {
//             this.simulateUpdateEvent();
//         });
//     }

//     // use getting to easily mock it
//     get roles() {
//         return this.rolesToGet();
//     }

//     // mock this method to get different roles
//     rolesToGet() {
//         return {};
//     }

//     async edit(editCommunityOptions: any) {
//         if (!this.address || typeof this.address !== "string") {
//             throw Error(`can't community.edit with no community.address`);
//         }
//         const previousAddress = this.address;

//         // do community.edit
//         for (const prop in editCommunityOptions) {
//             if (editCommunityOptions[prop]) {
//                 // @ts-ignore
//                 this[prop] = editCommunityOptions[prop];
//             }
//         }

//         // keep a list of edited communities to reinitialize
//         // them with pkc.createCommunity()
//         editedOwnerCommunitys[this.address] = {
//             address: this.address,
//             title: this.title,
//             description: this.description
//         };

//         // handle change of community.address
//         if (editCommunityOptions.address) {
//             // apply address change to editedOwnerCommunitys
//             editedOwnerCommunitys[previousAddress] = {
//                 address: this.address,
//                 title: this.title,
//                 description: this.description
//             };
//             delete editedOwnerCommunitys[previousAddress];

//             // apply address change to createdOwnerCommunitys
//             createdOwnerCommunitys[this.address] = {
//                 ...createdOwnerCommunitys[previousAddress],
//                 address: this.address
//             };
//             delete createdOwnerCommunitys[previousAddress];
//         }
//     }
// }
// // make roles enumarable so it acts like a regular prop
// Object.defineProperty(Community.prototype, "roles", { enumerable: true });

// // define it here because also used it pkc.getCommunity({address: )
// const getCommentsPage = (pageCid: string, community: any}) => {
//     const page: any = {
//         nextCid: community.address + " " + pageCid + " - next page cid",
//         comments: []
//     };
//     const postCount = 100;
//     let index = 0;
//     while (index++ < postCount) {
//         page.comments.push({
//             timestamp: index,
//             cid: pageCid + " comment cid " + index,
//             communityAddress: community.address,
//             upvoteCount: index,
//             downvoteCount: 10,
//             author: {
//                 address: pageCid + " author address " + index
//             },
//             updatedAt: index
//         });
//     }
//     return { ...page, _fetchAndVerifyPage: () => page };
// };

// let challengeRequestCount = 0;

// class Publication extends EventEmitter {
//     timestamp: number | undefined;
//     content: string | undefined;
//     cid: string | undefined;
//     challengeRequestId = new TextEncoder().encode(`r${++challengeRequestCount}`);
//     state: string | undefined;
//     publishingState: string | undefined;

//     async publish() {
//         this.state = "publishing";
//         this.publishingState = "publishing-challenge-request";
//         this.emit("statechange", "publishing");
//         this.emit("publishingstatechange", "publishing-challenge-request");

//         await simulateLoadingTime();
//         this.simulateChallengeEvent();
//     }

//     async stop() {}

//     simulateChallengeEvent() {
//         this.publishingState = "waiting-challenge-answers";
//         this.emit("publishingstatechange", "waiting-challenge-answers");

//         const challenge = { type: "text", challenge: "2+2=?" };
//         const challengeMessage = {
//             type: "CHALLENGE",
//             challengeRequestId: this.challengeRequestId,
//             challenges: [challenge]
//         };
//         this.emit("challenge", challengeMessage, this);
//     }

//     async publishChallengeAnswers(challengeAnswers: string[]) {
//         this.publishingState = "publishing-challenge-answer";
//         this.emit("publishingstatechange", "publishing-challenge-answer");

//         await simulateLoadingTime();
//         this.publishingState = "waiting-challenge-verification";
//         this.emit("publishingstatechange", "waiting-challenge-verification");

//         await simulateLoadingTime();
//         this.simulateChallengeVerificationEvent();
//     }

//     simulateChallengeVerificationEvent() {
//         // if publication has content, create cid for this content and add it to comment and challengeVerificationMessage
//         this.cid = this.content && `${this.content} cid`;
//         const publication = this.cid && { cid: this.cid };

//         const challengeVerificationMessage = {
//             type: "CHALLENGEVERIFICATION",
//             challengeRequestId: this.challengeRequestId,
//             challengeSuccess: true,
//             publication
//         };
//         this.emit("challengeverification", challengeVerificationMessage, this);

//         this.publishingState = "succeeded";
//         this.emit("publishingstatechange", "succeeded");
//     }
// }

// export class Comment extends Publication {
//     updateCalledTimes = 0;
//     updating = false;
//     author: any;
//     ipnsName: string | undefined;
//     upvoteCount: number | undefined;
//     downvoteCount: number | undefined;
//     override content: string | undefined;
//     parentCid: string | undefined;
//     replies: any;
//     updatedAt: number | undefined;
//     communityAddress: string | undefined;
//     override state: string;
//     updatingState: string;
//     override publishingState: string;

//     constructor(createCommentOptions?: any) {
//         super();
//         this.ipnsName = createCommentOptions?.ipnsName;
//         this.cid = createCommentOptions?.cid;
//         this.upvoteCount = createCommentOptions?.upvoteCount;
//         this.downvoteCount = createCommentOptions?.downvoteCount;
//         this.content = createCommentOptions?.content;
//         this.author = createCommentOptions?.author;
//         this.timestamp = createCommentOptions?.timestamp;
//         this.parentCid = createCommentOptions?.parentCid;
//         this.replies = new Pages({ comment: this });
//         this.communityAddress = createCommentOptions?.communityAddress;
//         this.state = "stopped";
//         this.updatingState = "stopped";
//         this.publishingState = "stopped";

//         if (createCommentOptions?.author?.address) {
//             this.author.shortAddress = `short ${createCommentOptions.author.address}`;
//         }
//         //@ts-expect-error
//         this.raw = {
//             comment: {
//                 ipnsName: this.ipnsName,
//                 content: this.content,
//                 author: this.author,
//                 timestamp: this.timestamp,
//                 parentCid: this.parentCid,
//                 communityAddress: this.communityAddress
//             }
//         };
//     }

//     async update() {
//         this.updateCalledTimes++;
//         if (this.updateCalledTimes > 2) {
//             throw Error(
//                 "with the current hooks, comment.update() should be called maximum 2 times, this number might change if the hooks change and is only there to catch bugs, the real comment.update() can be called infinite times"
//             );
//         }
//         // don't update twice
//         if (this.updating) {
//             return;
//         }
//         this.updating = true;

//         this.state = "updating";
//         this.updatingState = "fetching-ipfs";
//         this.emit("statechange", "updating");
//         this.emit("updatingstatechange", "fetching-ipfs");

//         simulateLoadingTime().then(() => {
//             this.simulateUpdateEvent();
//         });
//     }

//     simulateUpdateEvent() {
//         // if timestamp isn't defined, simulate fetching the comment ipfs
//         if (!this.timestamp) {
//             this.simulateFetchCommentIpfsUpdateEvent();
//             return;
//         }

//         // simulate finding vote counts on an IPNS record
//         this.upvoteCount = typeof this.upvoteCount === "number" ? this.upvoteCount + 2 : 3;
//         this.downvoteCount = typeof this.downvoteCount === "number" ? this.downvoteCount + 1 : 1;
//         this.updatedAt = Math.floor(Date.now() / 1000);

//         this.updatingState = "succeeded";
//         this.emit("update", this);
//         this.emit("updatingstatechange", "succeeded");
//     }

//     async simulateFetchCommentIpfsUpdateEvent() {
//         // use pkc.getComment({cid: ) so mocking PKC.prototype.getComment works
//         const commentIpfs = await new PKC(}).getComment({cid: this.cid || ""});
//         this.ipnsName = commentIpfs.ipnsName;
//         this.content = commentIpfs.content;
//         this.author = commentIpfs.author;
//         this.timestamp = commentIpfs.timestamp;
//         this.parentCid = commentIpfs.parentCid;
//         this.communityAddress = commentIpfs.communityAddress;

//         // simulate the ipns update
//         this.updatingState = "fetching-update-ipns";
//         this.emit("update", this);
//         this.emit("updatingstatechange", "fetching-update-ipns");
//         simulateLoadingTime().then(() => {
//             this.simulateUpdateEvent();
//         });
//     }
// }

// export class Vote extends Publication {}

// export class CommentEdit extends Publication {}

// export class CommunityEdit extends Publication {}

// export default async function () {
//     return new PKC();
// }
