import { EventEmitter } from "events";
import { plebbitJsChallenges } from "../../../dist/node/runtime/node/subplebbit/challenges/index.js";

// Define types for mock objects
interface MockAuthor {
    address: string;
    wallets?: { eth: { address: string; signature: string } };
    subplebbit?: {
        postScore?: number;
        replyScore?: number;
        firstCommentTimestamp?: number;
    };
}

interface MockSubplebbitChallengeSettings {
    name: string;
    options?: Record<string, string>;
    description?: string;
    exclude?: Array<Record<string, unknown>>;
}

interface MockSubplebbit {
    title: string;
    roles?: Record<string, { role: string }>;
    settings: {
        challenges: MockSubplebbitChallengeSettings[];
    };
    _plebbit?: MockPlebbit;
}

interface MockPlebbit {
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
        const subplebbitAddress = split[0];
        const karma = split[1];
        const age = split[2];
        this.communityAddress = subplebbitAddress;
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
                this.author.subplebbit = {
                    postScore: 1000,
                    replyScore: 1000
                };
            } else if (this.karma === "low") {
                this.author.subplebbit = {
                    postScore: 1,
                    replyScore: 1
                };
            }
            if (this.age === "old") {
                this.author.subplebbit!.firstCommentTimestamp = Math.round(Date.now() / 1000) - 60 * 60 * 24 * 999; // 999 days ago
            } else if (this.age === "new") {
                this.author.subplebbit!.firstCommentTimestamp = Math.round(Date.now() / 1000) - 60 * 60 * 24 * 1; // 1 day ago
            }
            this.emit("update", this);
        }, 5);
        timeout.unref?.();
    }

    stop(): void {
        this.removeAllListeners();
    }
}

// mock plebbit sync
const createPlebbit = (): MockPlebbit => {
    const getCidFromArg = (arg: string | { cid: string }): string => (typeof arg === "string" ? arg : arg?.cid);
    return {
        getComment: (cid) => new Comment(getCidFromArg(cid)),
        createComment: (cid) => new Comment(getCidFromArg(cid)),
        settings: {}
    };
};

// mock Plebbit async
const Plebbit = (): MockPlebbit => createPlebbit();

// define mock challenges included with plebbit-js
(Plebbit as unknown as { challenges: typeof plebbitJsChallenges }).challenges = plebbitJsChallenges;

// define mock Subplebbit instances
const textMathChallengeSubplebbit: MockSubplebbit = {
    title: "text-math challenge subplebbit",
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
// const captchaAndMathChallengeSubplebbit = {
//   title: 'captcha and math challenge subplebbit',
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
const excludeHighKarmaChallengeSubplebbit: MockSubplebbit = {
    title: "exclude high karma challenge subplebbit",
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
const excludeAccountAgeChallengeSubplebbit: MockSubplebbit = {
    title: "exclude account age challenge subplebbit",
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
const excludeAddressChallengeSubplebbit: MockSubplebbit = {
    title: "exclude address challenge subplebbit",
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
const whitelistChallengeSubplebbit: MockSubplebbit = {
    title: "whitelist challenge subplebbit",
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
const blacklistChallengeSubplebbit: MockSubplebbit = {
    title: "blacklist challenge subplebbit",
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
// const erc20PaymentChallengeSubplebbit = {
//   title: 'erc20 payment challenge subplebbit',
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
const passwordChallengeSubplebbit: MockSubplebbit = {
    title: "password challenge subplebbit",
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
const excludeFriendlySubKarmaChallengeSubplebbit: MockSubplebbit = {
    title: "exclude friendly sub karma challenge subplebbit",
    settings: {
        challenges: [
            {
                name: "fail",
                exclude: [
                    // exclude author with karma in those subs using publication.challengeCommentCids
                    {
                        subplebbit: {
                            addresses: ["friendly-sub.bso", "friendly-sub2.bso"],
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
const twoOutOf4SuccessChallengeSubplebbit: MockSubplebbit = {
    title: "2 out of 4 success challenge subplebbit",
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
const twoOutOf4SuccessInverseChallengeSubplebbit: MockSubplebbit = {
    title: "2 out of 4 success inverse challenge subplebbit",
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
const rateLimitChallengeSubplebbit: MockSubplebbit = {
    title: "rate limit challenge subplebbit",
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
const rateLimitChallengeSuccessChallengeSubplebbit: MockSubplebbit = {
    title: "rate limit challenge success challenge subplebbit",
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
const excludeModsChallengeSubplebbit: MockSubplebbit = {
    title: "exclude mods challenge subplebbit",
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
const questionOrWhitelistChallengeSubplebbit: MockSubplebbit = {
    title: "question or whitelist challenge subplebbit",
    settings: {
        challenges: [
            {
                name: "question",
                options: {
                    question: "What is the password?",
                    answer: "password"
                },
                // excluding the question challenge if subplebbit.challenges[1] (the whitelist)
                // passes creates a question OR whitelist condition
                exclude: [{ challenges: [1] }]
            },
            {
                name: "whitelist",
                options: { addresses: "high-karma.bso" },
                // excluding the whitelist challenge if subplebbit.challenges[0] (the question)
                // passes creates a question OR whitelist condition
                exclude: [{ challenges: [0] }]
            }
        ]
    }
};

// define mock author karma scores and account age
const subplebbitAuthors: Record<string, Record<string, { postScore?: number; replyScore?: number; firstCommentTimestamp?: number }>> = {};
subplebbitAuthors[highKarmaAuthor.address] = {};
subplebbitAuthors[highKarmaAuthor.address][excludeHighKarmaChallengeSubplebbit.title] = {
    postScore: 1000,
    replyScore: 1000,
    firstCommentTimestamp: 1
};
subplebbitAuthors[highKarmaAuthor.address][excludeAccountAgeChallengeSubplebbit.title] = {
    postScore: 1,
    replyScore: 1,
    firstCommentTimestamp: 1
};
subplebbitAuthors[lowKarmaAuthor.address] = {};
subplebbitAuthors[lowKarmaAuthor.address][excludeHighKarmaChallengeSubplebbit.title] = { postScore: 1, replyScore: 1000 };
subplebbitAuthors[lowKarmaAuthor.address][excludeAccountAgeChallengeSubplebbit.title] = { postScore: 1000, replyScore: 1000 };

// define mock friendly sub comment cids
const challengeCommentCids: Record<string, string[]> = {};
challengeCommentCids[highKarmaAuthor.address] = ["Qm...friendly-sub.bso,high,old", "Qm...friendly-sub.bso,high,old"];

const challengeAnswers: Record<string, Record<string, string[]>> = {};
challengeAnswers[highKarmaAuthor.address] = {};
challengeAnswers[highKarmaAuthor.address][passwordChallengeSubplebbit.title] = ["password"];
challengeAnswers[lowKarmaAuthor.address] = {};
challengeAnswers[lowKarmaAuthor.address][passwordChallengeSubplebbit.title] = ["wrong"];

const subplebbits: MockSubplebbit[] = [
    textMathChallengeSubplebbit,
    // captchaAndMathChallengeSubplebbit,
    excludeHighKarmaChallengeSubplebbit,
    excludeAccountAgeChallengeSubplebbit,
    excludeAddressChallengeSubplebbit,
    whitelistChallengeSubplebbit,
    blacklistChallengeSubplebbit,
    // erc20PaymentChallengeSubplebbit,
    // evmContractCallChallengeSubplebbit,
    passwordChallengeSubplebbit,
    excludeFriendlySubKarmaChallengeSubplebbit,
    twoOutOf4SuccessChallengeSubplebbit,
    twoOutOf4SuccessInverseChallengeSubplebbit,
    rateLimitChallengeSubplebbit,
    rateLimitChallengeSuccessChallengeSubplebbit,
    excludeModsChallengeSubplebbit,
    questionOrWhitelistChallengeSubplebbit
];

const results: Record<string, Record<string, MockChallengeResult>> = {};
results[textMathChallengeSubplebbit.title] = {
    "high-karma.bso": {
        pendingChallenges: [{ challenge: "660 - 256", type: "text/plain" }]
    },
    "low-karma.bso": {
        pendingChallenges: [{ challenge: "69 * 63", type: "text/plain" }]
    }
};
// comment out because don't know how to make the captcha node code work in the browser
// results[captchaAndMathChallengeSubplebbit.title] = {
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
results[excludeHighKarmaChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        pendingChallenges: [{ challenge: "82 * 45", type: "text/plain" }]
    }
};
results[excludeAccountAgeChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not allowed to publish." }
    }
};
results[excludeAddressChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not whitelisted." }
    }
};
results[whitelistChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not whitelisted." }
    }
};
results[blacklistChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're blacklisted." }
    }
};
// comment out because don't know how to require external challenge in the browser tests
// results[erc20PaymentChallengeSubplebbit.title] = {
//   'high-karma.bso': { challengeSuccess: true },
//   'low-karma.bso': {
//     challengeSuccess: false,
//     challengeErrors: {"0": "Author doesn't have wallet (eth) set." }
//   }
// }
results[passwordChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": { challengeSuccess: false, challengeErrors: { 0: "Wrong answer." } }
};
results[excludeFriendlySubKarmaChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not allowed to publish." }
    }
};
results[twoOutOf4SuccessChallengeSubplebbit.title] = {
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
results[twoOutOf4SuccessInverseChallengeSubplebbit.title] = {
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
results[rateLimitChallengeSubplebbit.title] = {
    "high-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're doing this too much, rate limit: 0 post/h, 10 replies/h, 100 votes/h." }
    },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're doing this too much, rate limit: 0 post/h, 10 replies/h, 100 votes/h." }
    }
};
results[rateLimitChallengeSuccessChallengeSubplebbit.title] = {
    "high-karma.bso": {
        challengeSuccess: true
    },
    "low-karma.bso": {
        challengeSuccess: true
    }
};
results[excludeModsChallengeSubplebbit.title] = {
    "high-karma.bso": {
        challengeSuccess: true
    },
    "low-karma.bso": {
        challengeSuccess: false,
        challengeErrors: { 0: "You're not a mod." }
    }
};
results[questionOrWhitelistChallengeSubplebbit.title] = {
    "high-karma.bso": { challengeSuccess: true },
    "low-karma.bso": {
        pendingChallenges: [{ challenge: "What is the password?", type: "text/plain" }]
    }
};

// add mock plebbit to add the mock subplebbit instances
for (const subplebbit of subplebbits) {
    subplebbit._plebbit = createPlebbit();
}

export { Plebbit, subplebbits, authors, subplebbitAuthors, challengeCommentCids, challengeAnswers, results };
