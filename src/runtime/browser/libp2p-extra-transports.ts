import { webTransport } from "@libp2p/webtransport";
import type { Libp2pOptions } from "libp2p";

const extraLibp2pTransports: NonNullable<Libp2pOptions["transports"]> = [webTransport()];

export default extraLibp2pTransports;
