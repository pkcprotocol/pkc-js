import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    SubplebbitChallengeSetting
} from "../../../../../community/types.js";
import { derivePublicationFromChallengeRequest } from "../../../../../util.js";
import { getCommunityAddressFromRecord } from "../../../../../publications/publication-community.js";

const optionInputs = <NonNullable<ChallengeFileInput["optionInputs"]>>[
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

const type: ChallengeInput["type"] = "text/plain";

const description = "Whitelist author addresses.";

class UrlsAddressesSet {
    private subplebbits: {
        [subplebbitAddress: string]: {
            urlsString: string | undefined;
            urls: string[];
            urlsSets: { [url: string]: Set<string> };
            setUrlsPromise?: Promise<void>;
        };
    } = {};

    constructor() {
        // refetch all urls in the background every 5min
        setInterval(() => this.refetchAndUpdateAllUrlsSets(), 1000 * 60 * 5).unref?.();
    }

    async has(address?: string, subplebbitAddress?: string, urlsString?: string): Promise<boolean> {
        if (!address || !subplebbitAddress || !urlsString) return false;
        // update urls on first run, wait for 10s max
        await this.setUrls(subplebbitAddress, urlsString);
        const subplebbit = this.subplebbits[subplebbitAddress];
        const urlsSets = subplebbit.urls.map((url) => subplebbit.urlsSets[url]).filter(Boolean);
        for (const urlSet of urlsSets) {
            if (urlSet.has(address)) {
                return true;
            }
        }
        return false;
    }

    private async setUrls(subplebbitAddress: string, urlsString: string): Promise<void> {
        let subplebbit = this.subplebbits[subplebbitAddress];
        if (subplebbit && urlsString === subplebbit.urlsString) {
            return subplebbit.setUrlsPromise;
        }
        this.subplebbits[subplebbitAddress] = {
            urlsString,
            urls:
                urlsString
                    ?.split(",")
                    .map((u) => u.trim())
                    .filter(Boolean) || [],
            urlsSets: {}
        };
        // try fetching urls before resolving
        this.subplebbits[subplebbitAddress].setUrlsPromise = Promise.race([
            Promise.all(this.subplebbits[subplebbitAddress].urls.map((url) => this.fetchAndUpdateUrlSet(url, [subplebbitAddress]))).then(
                () => {}
            ),
            // make sure to resolve after max 10s, or the initial urlsAddressesSet.has() could take infinite time
            new Promise<void>((resolve) => setTimeout(resolve, 10000))
        ]);
        return this.subplebbits[subplebbitAddress].setUrlsPromise;
    }

    private async fetchAndUpdateUrlSet(url: string, subplebbitAddresses: string[]): Promise<void> {
        try {
            const addresses: string[] = await fetch(url).then((res) => res.json() as Promise<string[]>);
            for (const subplebbitAddress of subplebbitAddresses) {
                this.subplebbits[subplebbitAddress].urlsSets[url] = new Set(addresses);
            }
        } catch {}
    }

    private refetchAndUpdateAllUrlsSets(): void {
        const urlToSubplebbitAddresses: { [url: string]: string[] } = {};
        for (const [subplebbitAddress, subplebbit] of Object.entries(this.subplebbits)) {
            for (const url of subplebbit.urls) {
                if (!urlToSubplebbitAddresses[url]) {
                    urlToSubplebbitAddresses[url] = [];
                }
                urlToSubplebbitAddresses[url].push(subplebbitAddress);
            }
        }
        for (const [url, subplebbitAddresses] of Object.entries(urlToSubplebbitAddresses)) {
            this.fetchAndUpdateUrlSet(url, subplebbitAddresses);
        }
    }
}
const urlsAddressesSet = new UrlsAddressesSet();

const getChallenge = async ({ challengeSettings, challengeRequestMessage }: GetChallengeArgsInput): Promise<ChallengeResultInput> => {
    // add a custom error message to display to the author
    const error = challengeSettings?.options?.error;
    const addresses = challengeSettings?.options?.addresses
        ?.split(",")
        .map((u) => u.trim())
        .filter(Boolean);
    const addressesSet = new Set(addresses);

    const publication = derivePublicationFromChallengeRequest(challengeRequestMessage);
    if (
        !addressesSet.has(publication?.author?.address) &&
        !(await urlsAddressesSet.has(
            publication?.author?.address,
            getCommunityAddressFromRecord(publication as unknown as Record<string, unknown>),
            challengeSettings?.options?.urls
        ))
    ) {
        return {
            success: false,
            error: error || `You're not whitelisted.`
        };
    }

    return {
        success: true
    };
};

function ChallengeFileFactory({ challengeSettings }: { challengeSettings: SubplebbitChallengeSetting }): ChallengeFileInput {
    return { getChallenge, optionInputs, type, description };
}

export default ChallengeFileFactory;
