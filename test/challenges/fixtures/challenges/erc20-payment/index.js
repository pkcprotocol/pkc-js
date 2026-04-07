// to pass this challenge, the author must send some ERC20 to the community owner
// the community owner must monitor the total sent by each sender to his address
// when an author publishes a post/reply/vote the community owner deducts from the
// total sent by the sender and allows the publication

const optionInputs = [
    {
        option: "chainTicker",
        label: "chainTicker",
        default: "",
        description: "",
        required: true
    },
    {
        option: "contractAddress",
        label: "contractAddress",
        default: "",
        description: "",
        required: true
    },
    {
        option: "recipientAddress",
        label: "recipientAddress",
        default: "",
        description: "The address to send the payments to.",
        required: true
    },
    {
        option: "symbol",
        label: "symbol",
        default: "",
        description: "The ticker of the token.",
        required: true
    },
    {
        option: "decimals",
        label: "decimals",
        default: "18",
        description: "The amount of decimals of the token."
    },
    {
        option: "postPrice",
        label: "postPrice",
        default: "0",
        description: "The payment for 1 post."
    },
    {
        option: "replyPrice",
        label: "replyPrice",
        default: "0",
        description: "The payment for 1 reply."
    },
    {
        option: "votePrice",
        label: "votePrice",
        default: "0",
        description: "The payment for 1 vote."
    }
];

const getPublicationPrice = ({ postPrice, replyPrice, votePrice }, publication) => {
    if (publication.vote !== undefined) {
        return votePrice;
    }
    if (publication.parentCid !== undefined) {
        return replyPrice;
    }
    return postPrice;
};

const verifyAuthorAddress = async (publication, chainTicker) => {
    const authorAddress = publication.author.wallets?.[chainTicker]?.address;
    const wallet = publication.author.wallets?.[chainTicker];
    const nftAvatar = publication.author?.avatar;
    if (authorAddress.endsWith(".eth") || authorAddress.endsWith(".bso")) {
        // resolve plebbit-author-address and check if it matches publication.signature.publicKey
        // return true
    }
    if (nftAvatar?.signature) {
        // validate if nftAvatar.signature matches authorAddress
        // validate if nftAvatar.signature matches author.wallets[chainTicker].address
        // return true
    }
    if (wallet?.signature) {
        // validate if wallet.signature matches JSON {domainSeparator:"plebbit-author-wallet",authorAddress:"${authorAddress}"}
        return true;
    }
    return false;
};

const getAuthorCredits = async ({ chainTicker, contractAddress, recipientAddress, decimals, symbol }, authorAddress) => {
    // mock getting the author credits from the blockchain using transfer logs
    // mock deduct the author spent credits from some database (dont use the sub database, use some other file)
    return 10000;
};

const incrementSpentAuthorCredits = async (authorAddress, amount) => {
    // mock incrementing the total spent credit by the author
};

const getChallenge = async ({ challengeSettings, challengeRequestMessage }) => {
    let { chainTicker, contractAddress, recipientAddress, symbol, decimals, postPrice, replyPrice, votePrice } =
        challengeSettings?.options || {};
    if (!chainTicker) {
        throw Error("missing option chainTicker");
    }
    if (!contractAddress) {
        throw Error("missing option contractAddress");
    }
    if (!recipientAddress) {
        throw Error("missing option recipientAddress");
    }
    // symbol isn't used in the challenge, but could be used to display the token symbol in frontend
    if (!symbol) {
        throw Error("missing option symbol");
    }
    if (!decimals) {
        throw Error("missing option decimals");
    }
    if (!postPrice) {
        throw Error("missing option postPrice");
    }
    postPrice = Number(postPrice);
    if (!replyPrice) {
        throw Error("missing option replyPrice");
    }
    replyPrice = Number(replyPrice);
    if (!votePrice) {
        throw Error("missing option votePrice");
    }
    votePrice = Number(votePrice);

    const publication = challengeRequestMessage.publication;

    const authorAddress = publication.author.wallets?.[chainTicker]?.address;
    if (!authorAddress) {
        return {
            success: false,
            error: `Author doesn't have wallet (${chainTicker}) set.`
        };
    }

    const verification = await verifyAuthorAddress(publication, chainTicker);
    if (!verification) {
        return {
            success: false,
            error: `Author doesn't signature proof of his wallet (${chainTicker}) address.`
        };
    }

    let authorCredits;
    try {
        authorCredits = await getAuthorCredits({ chainTicker, contractAddress, recipientAddress, decimals }, authorAddress);
    } catch (e) {
        return {
            success: false,
            error: `Failed getting author credits from blockchain (${chainTicker} ${symbol} ${contractAddress}).`
        };
    }

    const publicationPrice = await getPublicationPrice({ postPrice, replyPrice, votePrice }, publication);

    if (authorCredits < publicationPrice) {
        return {
            success: false,
            error: `Author doesn't have enough credits (${chainTicker} ${symbol} ${contractAddress}).`
        };
    }

    // NOTE: the credits will be deducted even if the publication fails a subsequent challenge
    // make sure to use payment challenge as last or to exlude subsequent challenges
    await incrementSpentAuthorCredits(authorAddress, publicationPrice);

    return {
        success: true
    };
};

function ChallengeFileFactory({ challengeSettings }) {
    let { chainTicker } = challengeSettings?.options || {};

    const type = "chain/" + (chainTicker || "<chainTicker>");
    return { getChallenge, optionInputs, type };
}

export default ChallengeFileFactory;
