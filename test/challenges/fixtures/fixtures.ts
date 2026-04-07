import { EventEmitter } from "events";
import { pkcJsChallenges } from "../../../dist/node/runtime/node/community/challenges/index.js";

// Define types for mock objects
interface MockAuthor {
    address: string;
    wallets?: { eth: { address: string; signature: string } };
    community?: {
        postScore?: number;
        replyScore?: number;
        firstCommentTimestamp?: number;
    };
}

interface MockCommunityChallengeSettings {
    name: string;
    options?: Record<string, string>;
    description?: string;
    exclude?: Array<Record<string, unknown>>;
}

interface MockCommunity {
    title: string;
    roles?: Record<string, { role: string }>;
    settings: {
        challenges: MockCommunityChallengeSettings[];
    };
    _pkc?: MockPKC;
}

interface MockPKC {
    getComment: (cid: string | { cid: string }) => Comment;
    createComment: (cid: string | { cid: string }) => Comment;
    settings?: { challenges?: Record<string, any> };
}

interface MockChallengeResult {
    challengeSuccess?: boolean;
    challengeErrors?: Record<number, string>;
    pendingChallenges?: Array<{ challenge: string; type: string }>;
}

// define mock Author instances
const highKarmaAuthor: MockAuthor = {
    address: "high-karma.bso",
    wallets: { eth: { address: "0x...", signature: "0x..." } }
};
const lowKarmaAuthor: MockAuthor = { address: "low-karma.bso" };
const authors: MockAuthor[] = [highKarmaAuthor, lowKarmaAuthor];

// mock comment class
class Comment extends EventEmitter {
    communityAddress: string;
    updatedAt: number | undefined;
    author: MockAuthor;
    karma: string | undefined;
    age: string | undefined;

    constructor(cid: string) {
        super();
        const split = cid.replace("Qm...", "").split(",");
        const communityAddress = split[0];
        const karma = split[1];
        const age = split[2];
        this.communityAddress = communityAddress;
        this.updatedAt = undefined;

        // define author
        this.author = { address: "Qm..." };
        if (karma === "high") {
            this.author.address = highKarmaAuthor.address;
        } else if (karma === "low") {
            this.author.address = lowKarmaAuthor.address;
        }

        // use this value to mock giving 'high' or 'low' karma to the author
        this.karma = karma;
        this.age = age;
    }

    update(): void {
        const timeout = setTimeout(() => {
            this.updatedAt = 123456;
            if (this.karma === "high") {
                this.author.community = {
                    postScore: 1000,
                    replyScore: 1000
                };
            } else if (this.karma === "low") {
                this.author.community = {
                    postScore: 1,
                    replyScore: 1
                };
            }
            if (this.age === "old") {
                this.author.community!.firstCommentTimestamp = Math.round(Date.now() / 1000) - 60 * 60 * 24 * 999; // 999 days ago
            } else if (this.age === "new") {
                this.author.community!.firstCommentTimestamp = Math.round(Date.now() / 1000) - 60 * 60 * 24 * 1; // 1 day ago
            }
            this.emit("update", this);
        }, 5);
        timeout.unref?.();
    }

    stop(): void {
        this.removeAllListeners();
    }
}

// mock pkc sync
const createPKC = (): MockPKC => {
    const getCidFromArg = (arg: string | { cid: string }): string => (typeof arg === "string" ? arg : arg?.cid);
    return {
        getComment: (cid) => new Comment(getCidFromArg(cid)),
        createComment: (cid) => new Comment(getCidFromArg(cid)),
        settings: {}
    };
};

// mock PKC async
const PKC = (): MockPKC => createPKC();

// define mock challenges included with pkc-js
(PKC as unknown as { challenges: typeof pkcJsChallenges }).challenges = pkcJsChallenges;

// define mock Community instances
const textMathChallengeCommunity: MockCommunity = {
    title: "text-math challenge community",
    settings: {
        challenges: [
            {
                name: "text-math",
                options: { difficulty: "3" },
                description: "Complete a math challenge."
            }
        ]
    }
};
// comment out because don't know how to make the captcha node code work in the browser
// const captchaAndMathChallengeCommunity = {
//   title: 'captcha and math challenge community',
//   settings: {
//     challenges: [
//       {
//         name: 'captcha-canvas-v3',
//         options: {
//           width: '600',
//           height: '400',
//           characters: '10',
//           color: '#000000'
//         },
//         description: 'Complete a captcha challenge.'
//       },
//       {
//         name: 'text-math',
//         options: {difficulty: '2'},
//         description: 'Complete a math challenge.'
//       }
//     ]
//   }
// }
const excludeHighKarmaChallengeCommunity: MockCommunity = {
    title: "exclude high karma challenge community",
    settings: {
        challenges: [
            {
                name: "text-math",
                options: { difficulty: "3" },
                // exclude if the author match any one item in the array
                exclude: [
                    { postScore: 100, replyScore: 100 }, // exclude author that has more than 100 post score AND 100 reply score
                    // exclude author with account age older than 100 days (Math.round(Date.now() / 1000)- 60*60*24*100)
                    { firstCommentTimestamp: 60 * 60 * 24 * 100 }
                ]
            }
        ]
    }
};
const excludeAccountAgeChallengeCommunity: MockCommunity = {
    title: "exclude account age challenge community",
    settings: {
        challenges: [
            {
                name: "fail",
                // exclude if the author match any one item in the array
                exclude: [
                    // exclude author with account age older than 100 days (Math.round(Date.now() / 1000)- 60*60*24*100)
                    { firstCommentTimestamp: 60 * 60 * 24 * 100 }
                ]
            }
        ]
    }
};
const excludeAddressChallengeCommunity: MockCommunity = {
    title: "exclude address challenge community",
    settings: {
        challenges: [
            {
                // the fail challenge always fails
                name: "fail",
                options: {
                    error: `You're not whitelisted.`
                },
                // challenge should never be triggered if the author address is excluded
                exclude: [{ address: ["high-karma.bso"] }]
            }
        ]
    }
};
const whitelistChallengeCommunity: MockCommunity = {
    title: "whitelist challenge community",
    settings: {
        challenges: [
            {
                name: "whitelist",
                options: {
                    addresses: "high-karma.bso"
                }
            }
        ]
    }
};
const blacklistChallengeCommunity: MockCommunity = {
    title: "blacklist challenge community",
    settings: {
        challenges: [
            {
                name: "blacklist",
                options: {
                    addresses: "low-karma.bso,some-author.bso"
                }
            }
        ]
    }
};
// comment out because don't know how to require external challenge in the browser tests
// const erc20PaymentChallengeCommunity = {
//   title: 'erc20 payment challenge community',
//   settings: {
//     challenges: [
//       {
//         path: path.join(__dirname, 'challenges', 'erc20-payment'),
//         options: {
//           chainTicker: 'eth',
//           contractAddress: '0x...',
//           recipientAddress: '0x...',
//           symbol: 'PLEB',
//           decimals: '18',
//           postPrice: '1000',
//           replyPrice: '100',
//           votePrice: '10'
//         },
//       },
//     ]
//   }
// }
const passwordChallengeCommunity: MockCommunity = {
    title: "password challenge community",
    settings: {
        challenges: [
            {
                name: "question",
                options: {
                    question: "What is the password?",
                    answer: "password"
                }
            }
        ]
    }
};
const excludeFriendlySubKarmaChallengeCommunity: MockCommunity = {
    title: "exclude friendly sub karma challenge community",
    settings: {
        challenges: [
            {
                name: "fail",
                exclude: [
                    // exclude author with karma in those subs using publication.challengeCommentCids
                    {
                        community: {
                            addresses: ["friendly-sub.bso", "friendly-community2.bso"],
                            postScore: 100,
                            replyScore: 100,
                            maxCommentCids: 3
                        }
                    }
                ]
            }
        ]
    }
};
const twoOutOf4SuccessChallengeCommunity: MockCommunity = {
    title: "2 out of 4 success challenge community",
    settings: {
        // challenge 0, 1 fail, but excluded if 2, 3 succeed, which makes challengeVerification.challengeSuccess = true
        challenges: [
            {
                name: "fail",
                exclude: [{ challenges: [2, 3] }]
            },
            {
                name: "fail",
                exclude: [{ challenges: [2, 3] }]
            },
            {
                name: "blacklist",
                options: { addresses: "low-karma.bso,some-author.bso" }
            },
            {
                name: "blacklist",
                options: { addresses: "low-karma.bso,some-author.bso" }
            }
        ]
    }
};
const twoOutOf4SuccessInverseChallengeCommunity: MockCommunity = {
    title: "2 out of 4 success inverse challenge community",
    settings: {
        // challenge 0, 1 fail, but excluded if 2, 3 succeed, which makes challengeVerification.challengeSuccess = true
        challenges: [
            {
                name: "blacklist",
                options: { addresses: "low-karma.bso,some-author.bso" }
            },
            {
                name: "blacklist",
                options: { addresses: "low-karma.bso,some-author.bso" }
            },
            {
                name: "fail",
                exclude: [{ challenges: [0, 1] }]
            },
            {
                name: "fail",
                exclude: [{ challenges: [0, 1] }]
            }
        ]
    }
};
const rateLimitChallengeCommunity: MockCommunity = {
    title: "rate limit challenge community",
    settings: {
        challenges: [
            {
                name: "fail",
                options: {
                    error: `You're doing this too much, rate limit: 0 post/h, 10 replies/h, 100 votes/h.`
                },
                exclude: [
                    // different rate limit per publication type
                    { publicationType: { post: true }, rateLimit: 0 }, // 0 per hour
                    { publicationType: { reply: true }, rateLimit: 10 }, // 10 per hour
                    { publicationType: { vote: true }, rateLimit: 100 } // 100 per hour
                ]
            }
        ]
    }
};
const rateLimitChallengeSuccessChallengeCommunity: MockCommunity = {
    title: "rate limit challenge success challenge community",
    settings: {
        challenges: [
            {
                name: "fail",
                options: {
                    error: `You're doing this too much.`
                },
                exclude: [
                    // only 1 successful publication per hour
                    { rateLimit: 1, rateLimitChallengeSuccess: true },
                    // only 100 failed challenge request per hour
                    { rateLimit: 100, rateLimitChallengeSuccess: false }
                ]
            }
        ]
    }
};
const excludeModsChallengeCommunity: MockCommunity = {
    title: "exclude mods challenge community",
    roles: {
        "high-karma.bso": {
            role: "moderator"
        }
    },
    settings: {
        challenges: [
            {
                name: "fail",
                options: {
                    error: `You're not a mod.`
                },
                exclude: [{ role: ["moderator", "admin", "owner"] }]
            }
        ]
    }
};
// test a challenge answer excluding a non challenge answer
const questionOrWhitelistChallengeCommunity: MockCommunity = {
    title: "question or whitelist challenge community",
    settings: {
        challenges: [
            {
                name: "question",
                options: {
                    question: "What is the password?",
                    answer: "password"
                },
                // excluding the question challenge if community.challenges[1] (the whitelist)
                // passes creates a question OR whitelist condition
                exclude: [{ challenges: [1] }]
            },
            {
                name: "whitelist",
                options: { addresses: "high-karma.bso" },
                // excluding the whitelist challenge if community.challenges[0] (the question)
                // passes creates a question OR whitelist condition
                exclude: [{ challenges: [0] }]
            }
        ]
    }
};

// define mock author karma scores and account age
const communityAuthors: Record<string, Record<string, { postScore?: number; replyScore?: number; firstCommentTimestamp?: number }>> = {};
communityAuthors[highKarmaAuthor.address] = {};
communityAuthors[highKarmaAuthor.address][excludeHighKarmaChallengeCommunity.title] = {
    postScore: 1000,
    replyScore: 1000,
    firstCommentTimestamp: 1
};
communityAuthors[highKarmaAuthor.address][excludeAccountAgeChallengeCommunity.title] = {
    postScore: 1,
    replyScore: 1,
    firstCommentTimestamp: 1
};
communityAuthors[lowKarmaAuthor.address] = {};
communityAuthors[lowKarmaAuthor.address][excludeHighKarmaChallengeCommunity.title] = { postScore: 1, replyScore: 1000 };
communityAuthors[lowKarmaAuthor.address][excludeAccountAgeChallengeCommunity.title] = { postScore: 1000, replyScore: 1000 };

// define mock friendly community comment cids
const challengeCommentCids: Record<string, string[]> = {};
challengeCommentCids[highKarmaAuthor.address] = ["Qm...friendly-sub.bso,high,old", "Qm...friendly-sub.bso,high,old"];

const challengeAnswers: Record<string, Record<string, string[]>> = {};
challengeAnswers[highKarmaAuthor.address] = {};
challengeAnswers[highKarmaAuthor.address][passwordChallengeCommunity.title] = ["password"];
challengeAnswers[lowKarmaAuthor.address] = {};
challengeAnswers[lowKarmaAuthor.address][passwordChallengeCommunity.title] = ["wrong"];

const communities: MockCommunity[] = [
    textMathChallengeCommunity,
    // captchaAndMathChallengeCommunity,
    excludeHighKarmaChallengeCommunity,
    excludeAccountAgeChallengeCommunity,
    excludeAddressChallengeCommunity,
    whitelistChallengeCommunity,
    blacklistChallengeCommunity,
    // erc20PaymentChallengeCommunity,
    // evmContractCallChallengeCommunity,
    passwordChallengeCommunity,
    excludeFriendlySubKarmaChallengeCommunity,
    twoOutOf4SuccessChallengeCommunity,
    twoOutOf4SuccessInverseChallengeCommunity,
    rateLimitChallengeCommunity,
    rateLimitChallengeSuccessChallengeCommunity,
    excludeModsChallengeCommunity,
    questionOrWhitelistChallengeCommunity
];

const results: Record<string, Record<string, MockChallengeResult>> = {};
results[textMathChallengeCommunity.title] = {
    "high-karma.bso": {
        pendingChallenges: [{ challenge: "660 - 256", type: "text/plain" }]
    },
    "low-karma.bso": {
        pendingChallenges: [{ challenge: "69 * 63", type: "text/plain" }]
    }
};
// comment out because don't know how to make the captcha node code work in the browser
// results[captchaAndMathChallengeCommunity.title] = {
//   'high-karma.bso': {
//     pendingChallenges: [
//       { challenge: '...', type: 'image' },
//       { challenge: '94 + 25', type: 'text/plain' }
//     ]
//   },
//   'low-karma.bso': {
//     pendingChallenges: [
//       { challenge: '...', type: 'image' },
//       { challenge: '99 - 90', type: 'text/plain' }
//     ]
//   }
// }
results[excludeHighKarmaChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        pendingChallenges: [{ challenge: "82 * 45", type: "text/plain" }]
    }
};
results[excludeAccountAgeChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not allowed to publish." }
    }
};
results[excludeAddressChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not whitelisted." }
    }
};
results[whitelistChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not whitelisted." }
    }
};
results[blacklistChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're blacklisted." }
    }
};
// comment out because don't know how to require external challenge in the browser tests
// results[erc20PaymentChallengeCommunity.title] = {
//   'high-karma.bso': { challengeSuccess: true },
//   'low-karma.bso': {
//     challengeSuccess: false,
//     challengeErrors: {"0": "Author doesn't have wallet (eth) set." }
//   }
// }
results[passwordChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": { challengeSuccess: false, challengeErrors: { 0: "Wrong answer." } }
};
results[excludeFriendlySubKarmaChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not allowed to publish." }
    }
};
results[twoOutOf4SuccessChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: {
            0: "You're not allowed to publish.",
            1: "You're not allowed to publish.",
            2: "You're blacklisted.",
            3: "You're blacklisted."
        }
    }
};
results[twoOutOf4SuccessInverseChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: {
            0: "You're blacklisted.",
            1: "You're blacklisted.",
            2: "You're not allowed to publish.",
            3: "You're not allowed to publish."
        }
    }
};
results[rateLimitChallengeCommunity.title] = {
    "high-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're doing this too much, rate limit: 0 post/h, 10 replies/h, 100 votes/h." }
    },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're doing this too much, rate limit: 0 post/h, 10 replies/h, 100 votes/h." }
    }
};
results[rateLimitChallengeSuccessChallengeCommunity.title] = {
    "high-karma.bso": {
        challengeSuccess: true
    },
    "low-karma.bso": {
        challengeSuccess: true
    }
};
results[excludeModsChallengeCommunity.title] = {
    "high-karma.bso": {
        challengeSuccess: true
    },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not a mod." }
    }
};
results[questionOrWhitelistChallengeCommunity.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        pendingChallenges: [{ challenge: "What is the password?", type: "text/plain" }]
    }
};

// add mock pkc to add the mock community instances
for (const community of communities) {
    community._pkc = createPKC();
}

export { PKC, communities, authors, communityAuthors, challengeCommentCids, challengeAnswers, results };
