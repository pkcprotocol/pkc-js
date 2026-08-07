import net from "node:net";

// Asks the OS for an unused loopback port, then releases it and returns the number.
//
// Use this instead of hardcoding a port constant in a test file. Vitest runs test files in separate
// processes and, under --parallel, several at once — so any port literal shared by two files is a
// latent flake that only fires when the scheduler happens to overlap them.
//
// There is a small window between releasing the port and the caller binding it. That is unavoidable
// without holding the socket open, but ephemeral ports are handed out from a large range and are not
// immediately reused, which makes this strictly safer than every file agreeing on the same constant.
export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                server.close(() => reject(Error("Failed to determine a free port: server.address() returned no port")));
                return;
            }
            const { port } = address;
            server.close(() => resolve(port));
        });
    });
}
