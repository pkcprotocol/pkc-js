import { describe, it, expect } from "vitest";
import { selectWinningGatewayCommunity } from "../../../dist/node/community/community-gateway-selection.js";
import type { CommunityGatewayFetch } from "../../../dist/node/community/community-gateway-selection.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";

// Regression test for the gateway ipnsHops race: gateways race and can resolve DIFFERENT chains,
// and the winner is chosen by updatedAt. The resolved ipnsHops must come from the gateway whose
// record we actually keep — NOT from whichever gateway callback happened to write last (the
// pre-fix bug mutated a shared field in callback order). selectWinningGatewayCommunity is a pure
// extraction of that selection so we can assert the binding directly.

const fakeGatewayEntry = (opts: { updatedAt: number; cid: string; ipnsHops?: string[] }) =>
    ({
        abortController: new AbortController(),
        promise: Promise.resolve(),
        cid: opts.cid,
        communityRecord: { updatedAt: opts.updatedAt } as unknown as CommunityIpfsType,
        timeoutId: 0,
        ipnsHops: opts.ipnsHops
    }) as CommunityGatewayFetch[string];

const ANCHOR = "12D3KooWAnchor";
const MINTER_X = "12D3KooWMinterX";
const MID = "12D3KooWIntermediate";
const MINTER_Y = "12D3KooWMinterY";

describe("selectWinningGatewayCommunity", () => {
    it("returns the winning (highest updatedAt) gateway's own ipnsHops when the winner is inserted FIRST", () => {
        const gatewayFetches = {
            "https://winner.example": fakeGatewayEntry({ updatedAt: 2000, cid: "cidWinner", ipnsHops: [ANCHOR, MINTER_X] }),
            "https://loser.example": fakeGatewayEntry({ updatedAt: 1000, cid: "cidLoser", ipnsHops: [ANCHOR, MID, MINTER_Y] })
        } as CommunityGatewayFetch;

        const result = selectWinningGatewayCommunity({ gatewayFetches, currentUpdatedAt: 0, totalGateways: 2, fallbackIpnsName: ANCHOR });
        expect(result).to.not.equal(undefined);
        expect(result!.cid).to.equal("cidWinner");
        expect(result!.bestGatewayUrl).to.equal("https://winner.example");
        expect(result!.ipnsHops).to.deep.equal([ANCHOR, MINTER_X]);
    });

    it("returns the winner's ipnsHops even when the winner is inserted LAST (selection by updatedAt, not order)", () => {
        const gatewayFetches = {
            "https://loser.example": fakeGatewayEntry({ updatedAt: 1000, cid: "cidLoser", ipnsHops: [ANCHOR, MID, MINTER_Y] }),
            "https://winner.example": fakeGatewayEntry({ updatedAt: 2000, cid: "cidWinner", ipnsHops: [ANCHOR, MINTER_X] })
        } as CommunityGatewayFetch;

        const result = selectWinningGatewayCommunity({ gatewayFetches, currentUpdatedAt: 0, totalGateways: 2, fallbackIpnsName: ANCHOR });
        expect(result!.cid).to.equal("cidWinner");
        expect(result!.ipnsHops).to.deep.equal([ANCHOR, MINTER_X]);
    });

    it("falls back to [fallbackIpnsName] when the winning gateway has no ipnsHops (non-delegated)", () => {
        const gatewayFetches = {
            "https://g.example": fakeGatewayEntry({ updatedAt: 2000, cid: "cid" }) // ipnsHops undefined
        } as CommunityGatewayFetch;

        const result = selectWinningGatewayCommunity({ gatewayFetches, currentUpdatedAt: 0, totalGateways: 1, fallbackIpnsName: ANCHOR });
        expect(result!.ipnsHops).to.deep.equal([ANCHOR]);
    });

    it("returns undefined when no gateway has a community record", () => {
        const gatewayFetches = {} as CommunityGatewayFetch;
        const result = selectWinningGatewayCommunity({ gatewayFetches, currentUpdatedAt: 0, totalGateways: 3, fallbackIpnsName: ANCHOR });
        expect(result).to.equal(undefined);
    });

    it("returns undefined when the best record is not newer than the current record", () => {
        const gatewayFetches = {
            "https://g.example": fakeGatewayEntry({ updatedAt: 1000, cid: "cid", ipnsHops: [ANCHOR] })
        } as CommunityGatewayFetch;
        // currentUpdatedAt equal to the best record -> nothing newer, and not all gateways accounted for
        const result = selectWinningGatewayCommunity({
            gatewayFetches,
            currentUpdatedAt: 1000,
            totalGateways: 3,
            fallbackIpnsName: ANCHOR
        });
        expect(result).to.equal(undefined);
    });
});
