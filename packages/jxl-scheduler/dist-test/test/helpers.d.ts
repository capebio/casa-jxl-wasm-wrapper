import type { WorkerHandle, WorkerFactory } from "../src/types.js";
import type { MainToWorkerMessage, WorkerToMainMessage } from "@casabio/jxl-core/protocol";
export declare class FakeWorker implements WorkerHandle {
    readonly messages: MainToWorkerMessage[];
    private handlers;
    private _terminated;
    get terminated(): boolean;
    send(msg: MainToWorkerMessage, _transfer?: ArrayBuffer[]): void;
    onMessage(handler: (msg: WorkerToMainMessage) => void): void;
    emit(msg: WorkerToMainMessage): void;
    shutdown(_timeoutMs?: number): Promise<void>;
}
export declare function fakeWorkerFactory(store: FakeWorker[]): WorkerFactory;
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";
export declare function makeDecodeStart(sessionId: string, priority?: "visible" | "near" | "background"): MsgDecodeStart;
//# sourceMappingURL=helpers.d.ts.map