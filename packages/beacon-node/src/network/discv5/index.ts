import EventEmitter from "events";
import {PeerId} from "@libp2p/interface-peer-id";
import StrictEventEmitter from "strict-event-emitter-types";
import {exportToProtobuf} from "@libp2p/peer-id-factory";
import {createKeypairFromPeerId, ENR, IDiscv5DiscoveryInputOptions} from "@chainsafe/discv5";
import {spawn, Thread, Worker} from "@chainsafe/threads";
import {ILogger} from "@lodestar/utils";
import {IMetrics} from "../../metrics/metrics.js";
import {Discv5WorkerApi, Discv5WorkerData} from "./types.js";

export type Discv5Opts = {
  peerId: PeerId;
  discv5: Omit<IDiscv5DiscoveryInputOptions, "metrics" | "searchInterval" | "enabled">;
  logger: ILogger;
  metrics?: IMetrics;
};

export interface IDiscv5Events {
  discovered: (enr: ENR) => void;
}

type Discv5WorkerStatus =
  | {status: "stopped"}
  | {status: "started"; workerApi: Discv5WorkerApi; subscription: {unsubscribe(): void}};

/**
 * Wrapper class abstracting the details of discv5 worker instantiation and message-passing
 */
export class Discv5Worker extends (EventEmitter as {new (): StrictEventEmitter<EventEmitter, IDiscv5Events>}) {
  private logger: ILogger;
  private status: Discv5WorkerStatus;

  constructor(private opts: Discv5Opts) {
    super();

    this.logger = opts.logger;
    this.status = {status: "stopped"};
  }

  async start(): Promise<void> {
    if (this.status.status === "started") return;

    const keypair = createKeypairFromPeerId(this.opts.peerId);
    const workerData: Discv5WorkerData = {
      enrStr: (this.opts.discv5.enr as ENR).encodeTxt(keypair.privateKey),
      peerIdProto: exportToProtobuf(this.opts.peerId),
      bindAddr: this.opts.discv5.bindAddr,
      config: this.opts.discv5,
      bootEnrs: this.opts.discv5.bootEnrs as string[],
      metrics: Boolean(this.opts.metrics),
    };
    const worker = new Worker("./worker.js", {workerData} as ConstructorParameters<typeof Worker>[1]);

    const workerApi = await spawn<Discv5WorkerApi>(worker, {
      // A Lodestar Node may do very expensive task at start blocking the event loop and causing
      // the initialization to timeout. The number below is big enough to almost disable the timeout
      timeout: 5 * 60 * 1000,
    });

    const subscription = workerApi.discoveredBuf().subscribe((enrStr) => this.onDiscoveredStr(enrStr));

    this.status = {status: "started", workerApi, subscription};
  }

  async stop(): Promise<void> {
    if (this.status.status === "stopped") return;

    this.status.subscription.unsubscribe();
    await this.status.workerApi.close();
    await Thread.terminate((this.status.workerApi as unknown) as Thread);

    this.status = {status: "stopped"};
  }

  onDiscoveredStr(enrBuf: Uint8Array): void {
    const enr = this.decodeEnr(enrBuf);
    if (enr) {
      this.emit("discovered", enr);
    }
  }

  async enr(): Promise<ENR> {
    if (this.status.status === "started") {
      return ENR.decode(Buffer.from(await this.status.workerApi.enrBuf()));
    } else {
      throw new Error("Cannot get enr before module is started");
    }
  }

  async setEnrValue(key: string, value: Uint8Array): Promise<void> {
    if (this.status.status === "started") {
      await this.status.workerApi.setEnrValue(key, value);
    } else {
      throw new Error("Cannot setEnrValue before module is started");
    }
  }

  async kadValues(): Promise<ENR[]> {
    if (this.status.status === "started") {
      return this.decodeEnrs(await this.status.workerApi.kadValuesBuf());
    } else {
      return [];
    }
  }

  async findRandomNode(): Promise<ENR[]> {
    if (this.status.status === "started") {
      return this.decodeEnrs(await this.status.workerApi.findRandomNodeBuf());
    } else {
      return [];
    }
  }

  async metrics(): Promise<string> {
    if (this.status.status === "started") {
      return await this.status.workerApi.metrics();
    } else {
      return "";
    }
  }

  private decodeEnrs(enrBufs: Uint8Array[]): ENR[] {
    const enrs: ENR[] = [];
    for (const enrBuf of enrBufs) {
      const enr = this.decodeEnr(enrBuf);
      if (enr) {
        enrs.push(enr);
      }
    }
    return enrs;
  }

  private decodeEnr(enrBuf: Uint8Array): ENR | null {
    try {
      this.opts.metrics?.discv5.decodeEnrAttemptCount.inc(1);
      return ENR.decode(Buffer.from(enrBuf));
    } catch (e) {
      this.opts.metrics?.discv5.decodeEnrErrorCount.inc(1);
      // Log to recover ENR from logs and debug why it is invalid
      this.logger.debug("ENR decode error", {
        enr: Buffer.from(enrBuf).toString("base64url"),
        error: (e as Error).message,
      });
      return null;
    }
  }
}
