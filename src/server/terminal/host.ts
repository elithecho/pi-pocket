/** One child per conversation: bounded IPC, cancellable requests, and deterministic disposal. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    parseFromHost,
    parseToHost,
    type FromHost,
    type HostDialog,
    type HostLogEntry,
    type HostOperation,
    type HostReady,
    type HostSnapshot,
    type ToHost,
} from "./protocol.ts";

export interface ExtensionHostOptions {
    cwd: string;
    agentDir: string;
    trusted: boolean;
    snapshot: HostSnapshot;
    onDialog(operation: string, id: string, dialog: HostDialog): Promise<string | boolean | null>;
    onExit?(error: Error): void;
    /** Track the child before initialization or any extension startup handler can wait. */
    onSpawn?(host: ExtensionHost): void;
    timeoutMs?: number;
}

type Reply = Extract<FromHost, { type: "ready" | "result" }>;
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void };

export class ExtensionHost {
    readonly id = randomUUID();
    readonly #child: ChildProcess;
    readonly #pending = new Map<string, Pending>();
    readonly #options: ExtensionHostOptions;
    readonly #exited: Promise<void>;
    #closing: Promise<void> | undefined;
    #closed = false;
    #diagnostics = "";
    #acknowledged = 0;
    #received = 0;
    readonly #catalogues = new Map<number, Pick<HostReady, "commands" | "tools">>();
    #dialogs = 0;
    #ready!: HostReady;

    private constructor(options: ExtensionHostOptions) {
        this.#options = options;
        this.#child = fork(new URL("./worker.ts", import.meta.url), [], {
            cwd: options.cwd,
            execArgv: [],
            env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        this.#exited = new Promise((resolve) => {
            this.#child.once("exit", (code, signal) => {
                const unexpected = !this.#closed;
                const error = new Error(
                    `Pi extension host exited (${signal ?? code})${this.#diagnostics ? `: ${this.#diagnostics}` : ""}`,
                );

                this.#closed = true;
                this.#rejectAll(error);
                resolve();

                if (unexpected) {
                    options.onExit?.(error);
                }
            });
            this.#child.once("error", (error) => {
                this.#closed = true;
                this.#rejectAll(error);
                resolve();
            });
        });

        const diagnostic = (data: Buffer) => {
            this.#diagnostics = (this.#diagnostics + data.toString()).slice(-16_000);
        };

        this.#child.stdout?.on("data", diagnostic);
        this.#child.stderr?.on("data", diagnostic);
        this.#child.on("message", (value) => {
            try {
                this.#receive(parseFromHost(value));
            } catch (error) {
                this.#fail(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    static async open(options: ExtensionHostOptions): Promise<ExtensionHost> {
        const host = new ExtensionHost(options);

        options.onSpawn?.(host);

        try {
            const reply = await host.#request({
                type: "initialize",
                id: randomUUID(),
                cwd: options.cwd,
                agentDir: options.agentDir,
                trusted: options.trusted,
                snapshot: options.snapshot,
            });

            if (reply.type !== "ready") {
                throw new Error("Pi extension host did not return its command catalogue");
            }

            host.#ready = reply;

            return host;
        } catch (error) {
            await host.close();

            throw error;
        }
    }

    get catalogue(): HostReady {
        return this.#ready;
    }

    get pid(): number | undefined {
        return this.#child.pid;
    }

    get closed(): boolean {
        return this.#closed;
    }

    async invoke(
        id: string,
        operation: HostOperation,
        snapshot: HostSnapshot,
        signal?: AbortSignal,
    ): Promise<HostLogEntry[]> {
        const reply = await this.#request({ type: "invoke", id, operation, snapshot }, signal);

        if (reply.type !== "result") {
            throw new Error("Pi extension host returned a catalogue for an operation");
        }

        let previous = this.#acknowledged;

        for (const item of reply.log) {
            // A response can overlap a prefix acknowledged while this reply was in flight.
            if (item.seq <= this.#acknowledged) {
                continue;
            }

            if (item.seq !== previous + 1) {
                const error = new Error("Pi extension host returned a non-contiguous effect log");

                this.#fail(error);

                throw error;
            }

            previous = item.seq;
        }

        if (!reply.log.some((item) => item.operation === id && item.effect.kind === "complete")) {
            const error = new Error("Pi extension host returned no completion marker");

            this.#fail(error);

            throw error;
        }

        this.#received = Math.max(this.#received, previous);

        for (const item of reply.log) {
            if (item.seq > this.#acknowledged && item.effect.kind === "catalogue") {
                this.#catalogues.set(item.seq, item.effect.catalogue);
            }
        }

        return reply.log;
    }

    /** Call ONLY after Pocket has durably committed this exact effect prefix. */
    acknowledge(through: number): void {
        if (
            !Number.isSafeInteger(through) ||
            through < this.#acknowledged ||
            through > this.#received
        ) {
            throw new Error("Invalid Pi extension effect acknowledgement");
        }

        if (through === this.#acknowledged) {
            return;
        }

        for (const [seq, catalogue] of this.#catalogues) {
            if (seq <= through) {
                this.#ready = { ...this.#ready, ...catalogue };
                this.#catalogues.delete(seq);
            }
        }

        this.#acknowledged = through;
        this.#send({ type: "ack", through });
    }

    #send(packet: ToHost): void {
        if (this.#closed || !this.#child.connected) {
            throw new Error("Pi extension host is no longer connected");
        }

        this.#child.send(parseToHost(packet), (error) => {
            if (error) {
                this.#fail(error);
            }
        });
    }

    async #request(
        packet: Extract<ToHost, { type: "initialize" | "invoke" }>,
        signal?: AbortSignal,
    ): Promise<Reply> {
        if (this.#pending.size >= 32) {
            throw new Error(
                "Pi extension host has too many pending operations; retry after some finish",
            );
        }

        if (this.#pending.has(packet.id)) {
            throw new Error("A Pi extension operation with this request id is already running");
        }

        if (signal?.aborted) {
            throw new Error("Pi extension operation was cancelled");
        }

        const reply = new Promise<Reply>((resolve, reject) => {
            this.#pending.set(packet.id, { resolve, reject });
        });
        const timeout = setTimeout(
            () => {
                this.#fail(
                    new Error("Pi extension operation timed out; it was interrupted, not replayed"),
                );
            },
            packet.type === "initialize"
                ? Math.min(this.#options.timeoutMs ?? 15_000, 15_000)
                : (this.#options.timeoutMs ?? 600_000),
        );

        const abort = () => {
            this.#fail(new Error("Pi extension operation was cancelled; its host was invalidated"));
        };

        signal?.addEventListener("abort", abort, { once: true });

        try {
            this.#send(packet);

            return await reply;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            this.#pending.delete(packet.id);
        }
    }

    #receive(packet: FromHost): void {
        if (packet.type === "error") {
            this.#fail(new Error(packet.message));
        } else if (packet.type === "dialog") {
            if (!this.#pending.has(packet.operation) || this.#dialogs >= 20) {
                this.#fail(new Error("Pi extension requested a dialog outside a live operation"));

                return;
            }

            this.#dialogs++;
            void this.#options
                .onDialog(packet.operation, packet.id, packet.dialog)
                .then(
                    (value) => {
                        if (!this.#closed) {
                            this.#send({ type: "answer", id: packet.id, value });
                        }
                    },
                    () => {
                        if (!this.#closed) {
                            this.#send({ type: "answer", id: packet.id, value: null });
                        }
                    },
                )
                .finally(() => this.#dialogs--)
                .catch((error) => {
                    this.#fail(error instanceof Error ? error : new Error(String(error)));
                });
        } else {
            const pending = this.#pending.get(packet.id);

            if (!pending) {
                throw new Error("Pi extension returned a stale or unknown operation id");
            }

            pending.resolve(packet);
        }
    }

    #rejectAll(error: Error): void {
        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }

        this.#pending.clear();
    }

    #fail(error: Error): void {
        if (this.#closed) {
            return;
        }

        this.#rejectAll(error);
        this.#options.onExit?.(error);
        void this.close();
    }

    close(): Promise<void> {
        this.#closing ??= (async () => {
            const connected = this.#child.connected;

            this.#closed = true;
            this.#rejectAll(new Error("Pi extension host was disposed"));

            if (connected) {
                this.#child.send({ type: "close" }, () => {});
            }

            const kill = setTimeout(() => this.#child.kill("SIGKILL"), 1000);

            try {
                await this.#exited;
            } finally {
                clearTimeout(kill);
            }
        })();

        return this.#closing;
    }
}
