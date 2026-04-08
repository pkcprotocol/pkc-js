import { derivePublicationFromChallengeRequest } from "../../../../../util.js";
import { getCommunityAddressFromRecord } from "../../../../../publications/publication-community.js";
const optionInputs = [
    {
        option: "addresses",
        label: "Addresses",
        default: "",
        description: "Comma separated list of author addresses to be whitelisted.",
        placeholder: `address1.bso,address2.bso,address3.bso`
    },
    {
        option: "urls",
        label: "URLs",
        default: "",
        description: "Comma separated list of URLs to fetch whitelists from (JSON arrays of addresses)",
        placeholder: `https://example.com/file.json,https://github.com/whitelist.json`
    },
    {
        option: "error",
        label: "Error",
        default: `You're not whitelisted.`,
        description: "The error to display to the author.",
        placeholder: `You're not whitelisted.`
    }
];
const type = "text/plain";
const description = "Whitelist author addresses.";
class UrlsAddressesSet {
    constructor() {
        this.communities = {};
        // refetch all urls in the background every 5min
        setInterval(() => this.refetchAndUpdateAllUrlsSets(), 1000 * 60 * 5).unref?.();
    }
    async has(address, communityAddress, urlsString) {
        if (!address || !communityAddress || !urlsString)
            return false;
        // update urls on first run, wait for 10s max
        await this.setUrls(communityAddress, urlsString);
        const community = this.communities[communityAddress];
        const urlsSets = community.urls.map((url) => community.urlsSets[url]).filter(Boolean);
        for (const urlSet of urlsSets) {
            if (urlSet.has(address)) {
                return true;
            }
        }
        return false;
    }
    async setUrls(communityAddress, urlsString) {
        let community = this.communities[communityAddress];
        if (community && urlsString === community.urlsString) {
            return community.setUrlsPromise;
        }
        this.communities[communityAddress] = {
            urlsString,
            urls: urlsString
                ?.split(",")
                .map((u) => u.trim())
                .filter(Boolean) || [],
            urlsSets: {}
        };
        // try fetching urls before resolving
        this.communities[communityAddress].setUrlsPromise = Promise.race([
            Promise.all(this.communities[communityAddress].urls.map((url) => this.fetchAndUpdateUrlSet(url, [communityAddress]))).then(() => { }),
            // make sure to resolve after max 10s, or the initial urlsAddressesSet.has() could take infinite time
            new Promise((resolve) => setTimeout(resolve, 10000))
        ]);
        return this.communities[communityAddress].setUrlsPromise;
    }
    async fetchAndUpdateUrlSet(url, communityAddresses) {
        try {
            const addresses = await fetch(url).then((res) => res.json());
            for (const communityAddress of communityAddresses) {
                this.communities[communityAddress].urlsSets[url] = new Set(addresses);
            }
        }
        catch { }
    }
    refetchAndUpdateAllUrlsSets() {
        const urlToCommunityAddresses = {};
        for (const [communityAddress, community] of Object.entries(this.communities)) {
            for (const url of community.urls) {
                if (!urlToCommunityAddresses[url]) {
                    urlToCommunityAddresses[url] = [];
                }
                urlToCommunityAddresses[url].push(communityAddress);
            }
        }
        for (const [url, communityAddresses] of Object.entries(urlToCommunityAddresses)) {
            this.fetchAndUpdateUrlSet(url, communityAddresses);
        }
    }
}
const urlsAddressesSet = new UrlsAddressesSet();
const getChallenge = async ({ challengeSettings, challengeRequestMessage }) => {
    // add a custom error message to display to the author
    const error = challengeSettings?.options?.error;
    const addresses = challengeSettings?.options?.addresses
        ?.split(",")
        .map((u) => u.trim())
        .filter(Boolean);
    const addressesSet = new Set(addresses);
    const publication = derivePublicationFromChallengeRequest(challengeRequestMessage);
    if (!addressesSet.has(publication?.author?.address) &&
        !(await urlsAddressesSet.has(publication?.author?.address, getCommunityAddressFromRecord(publication), challengeSettings?.options?.urls))) {
        return {
            success: false,
            error: error || `You're not whitelisted.`
        };
    }
    return {
        success: true
    };
};
function ChallengeFileFactory({ challengeSettings }) {
    return { getChallenge, optionInputs, type, description };
}
export default ChallengeFileFactory;
//# sourceMappingURL=whitelist.js.map