import { describe, it, expect, vi, afterEach } from "vitest";
// The shim lives in the browser runtime, but it only touches the constructor it is given, so its
// logic is tested here in Node against a double. The real-browser check is
// test/node-and-browser/helia/webtransport-abort-crash.test.ts.
import { installWebTransportCloseShim } from "../../../dist/node/runtime/browser/webtransport-close-shim.js";
import { installWebTransportCloseShim as installNodeNoop } from "../../../dist/node/runtime/node/webtransport-close-shim.js";

// pkc-js#495: Chromium crashes the renderer when a WebTransport stream has a write pending, then
// writer.abort(), then WebTransport.close() run in one synchronous task. The shim moves the real
// close() to the next microtask.

type CloseCall = { session: object; args: unknown[] };

function createFakeWebTransport({ closeThrowsWhenGivenArgs = false }: { closeThrowsWhenGivenArgs?: boolean } = {}) {
    const closeCalls: CloseCall[] = [];
    class FakeWebTransport {
        close(...args: unknown[]): void {
            closeCalls.push({ session: this, args });
            if (closeThrowsWhenGivenArgs && args.length > 0) throw new TypeError("malformed closeInfo");
        }
    }
    return { FakeWebTransport, closeCalls };
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("WebTransport close shim (pkc-js#495)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("runs the real close() one microtask later, not in the calling task", async () => {
        const { FakeWebTransport, closeCalls } = createFakeWebTransport();
        expect(installWebTransportCloseShim({ WebTransportConstructor: FakeWebTransport })).to.equal("installed");

        const session = new FakeWebTransport();
        const order: string[] = [];
        queueMicrotask(() => order.push(`microtask queued before close(), real close calls so far: ${closeCalls.length}`));
        const returned = session.close();
        order.push(`sync after close(), real close calls so far: ${closeCalls.length}`);
        queueMicrotask(() => order.push(`microtask queued after close(), real close calls so far: ${closeCalls.length}`));

        expect(returned).to.equal(undefined);
        expect(closeCalls).to.have.length(0);
        await flushMicrotasks();
        expect(order).to.deep.equal([
            "sync after close(), real close calls so far: 0",
            "microtask queued before close(), real close calls so far: 0",
            "microtask queued after close(), real close calls so far: 1"
        ]);
        expect(closeCalls).to.have.length(1);
    });

    it("passes the session and closeInfo through to the real close()", async () => {
        const { FakeWebTransport, closeCalls } = createFakeWebTransport();
        installWebTransportCloseShim({ WebTransportConstructor: FakeWebTransport });

        const first = new FakeWebTransport();
        const second = new FakeWebTransport();
        const closeInfo = { closeCode: 7, reason: "bye" };
        (first.close as (info: unknown) => void)(closeInfo);
        second.close();
        await flushMicrotasks();

        expect(closeCalls).to.have.length(2);
        expect(closeCalls[0].session).to.equal(first);
        expect(closeCalls[0].args).to.deep.equal([closeInfo]);
        expect(closeCalls[1].session).to.equal(second);
        expect(closeCalls[1].args).to.deep.equal([]);
    });

    it("wraps only once, however many times it is installed", async () => {
        const { FakeWebTransport, closeCalls } = createFakeWebTransport();
        expect(installWebTransportCloseShim({ WebTransportConstructor: FakeWebTransport })).to.equal("installed");
        const wrappedOnce = FakeWebTransport.prototype.close;
        expect(installWebTransportCloseShim({ WebTransportConstructor: FakeWebTransport })).to.equal("already-installed");
        expect(installWebTransportCloseShim({ WebTransportConstructor: FakeWebTransport })).to.equal("already-installed");
        expect(FakeWebTransport.prototype.close).to.equal(wrappedOnce);

        new FakeWebTransport().close();
        // a double wrap would need a second microtask before the real close() runs
        await flushMicrotasks();
        expect(closeCalls).to.have.length(1);
    });

    it("keeps the property attributes of the original close", () => {
        const { FakeWebTransport } = createFakeWebTransport();
        const before = Object.getOwnPropertyDescriptor(FakeWebTransport.prototype, "close")!;
        installWebTransportCloseShim({ WebTransportConstructor: FakeWebTransport });
        const after = Object.getOwnPropertyDescriptor(FakeWebTransport.prototype, "close")!;
        expect({ configurable: after.configurable, enumerable: after.enumerable, writable: after.writable }).to.deep.equal({
            configurable: before.configurable,
            enumerable: before.enumerable,
            writable: before.writable
        });
        expect(after.value).to.not.equal(before.value);
    });

    it("patches globalThis.WebTransport by default", async () => {
        const { FakeWebTransport, closeCalls } = createFakeWebTransport();
        vi.stubGlobal("WebTransport", FakeWebTransport);
        expect(installWebTransportCloseShim()).to.equal("installed");
        new FakeWebTransport().close();
        expect(closeCalls).to.have.length(0);
        await flushMicrotasks();
        expect(closeCalls).to.have.length(1);
    });

    it("is a no-op when the runtime has no WebTransport", () => {
        vi.stubGlobal("WebTransport", undefined);
        expect(installWebTransportCloseShim()).to.equal("unavailable");
        expect((globalThis as { WebTransport?: unknown }).WebTransport).to.equal(undefined);
    });

    it("still closes the session and reports the error when the real close() throws", async () => {
        const { FakeWebTransport, closeCalls } = createFakeWebTransport({ closeThrowsWhenGivenArgs: true });
        const reportError = vi.fn();
        vi.stubGlobal("reportError", reportError);
        installWebTransportCloseShim({ WebTransportConstructor: FakeWebTransport });

        const session = new FakeWebTransport();
        expect(() => (session.close as (info: unknown) => void)({ closeCode: -1 })).to.not.throw();
        await flushMicrotasks();

        // first the caller's closeInfo (throws), then a bare close() so the session never stays open
        expect(closeCalls.map((call) => call.args.length)).to.deep.equal([1, 0]);
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError.mock.calls[0][0]).to.be.instanceOf(TypeError);
    });

    it("the Node runtime counterpart never patches anything", () => {
        const { FakeWebTransport } = createFakeWebTransport();
        const original = FakeWebTransport.prototype.close;
        vi.stubGlobal("WebTransport", FakeWebTransport);
        expect(installNodeNoop()).to.equal("unavailable");
        expect(FakeWebTransport.prototype.close).to.equal(original);
    });
});
