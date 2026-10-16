/** Contiguous, bounded request frames; no partially received request reaches plugin dispatch. */
import { randomUUID } from "node:crypto";
import {
    MAX_PACKET_BYTES,
    MAX_REQUEST_BYTES,
    parseToHost,
    wireValue,
    type ToHost,
} from "./protocol.ts";

export const REQUEST_CHUNK_BYTES = 256 * 1024;

export interface RequestChunk {
    type: "request-chunk";
    transfer: string;
    bytes: number;
    offset: number;
    data: string;
}

export function* encodeRequest(value: ToHost): Generator<ToHost | RequestChunk> {
    const packet = parseToHost(value);
    const bytes = Buffer.from(JSON.stringify(packet));

    if (bytes.length <= MAX_PACKET_BYTES) {
        yield packet;

        return;
    }

    const transfer = randomUUID();

    for (let offset = 0; offset < bytes.length; offset += REQUEST_CHUNK_BYTES) {
        yield {
            type: "request-chunk",
            transfer,
            bytes: bytes.length,
            offset,
            data: bytes.subarray(offset, offset + REQUEST_CHUNK_BYTES).toString("base64"),
        };
    }
}

type Transfer = { id: string; buffer: Buffer; offset: number };

export class RequestDecoder {
    #transfer: Transfer | undefined;

    clear(): void {
        this.#transfer = undefined;
    }

    receive(value: unknown): ToHost | undefined {
        try {
            return this.#receive(value);
        } catch (error) {
            this.clear();

            throw error;
        }
    }

    #receive(value: unknown): ToHost | undefined {
        // Logical request parsing has a larger allowance, never the raw IPC-frame allowance.
        const frame = wireValue(value);

        if (
            frame === null ||
            typeof frame !== "object" ||
            Array.isArray(frame) ||
            frame.type !== "request-chunk"
        ) {
            const packet = parseToHost(frame);

            if (this.#transfer && packet.type !== "close") {
                throw new Error("Terminal extension request frames were interleaved");
            }

            this.clear();

            return packet;
        }

        const { transfer, bytes, offset, data } = frame;

        if (
            Object.keys(frame).length !== 5 ||
            typeof transfer !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(transfer) ||
            typeof bytes !== "number" ||
            !Number.isSafeInteger(bytes) ||
            bytes <= MAX_PACKET_BYTES ||
            bytes > MAX_REQUEST_BYTES ||
            typeof offset !== "number" ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset >= bytes ||
            typeof data !== "string" ||
            data.length > Math.ceil(REQUEST_CHUNK_BYTES / 3) * 4
        ) {
            throw new Error("Invalid terminal extension request frame");
        }

        const chunk = Buffer.from(data, "base64");

        if (
            chunk.length !== Math.min(REQUEST_CHUNK_BYTES, bytes - offset) ||
            chunk.toString("base64") !== data
        ) {
            throw new Error("Invalid terminal extension request chunk data");
        }

        if (!this.#transfer) {
            if (offset !== 0) {
                throw new Error("Terminal extension request must start at byte zero");
            }

            this.#transfer = { id: transfer, buffer: Buffer.allocUnsafe(bytes), offset: 0 };
        }

        const current = this.#transfer;

        if (
            current.id !== transfer ||
            current.buffer.length !== bytes ||
            current.offset !== offset
        ) {
            throw new Error("Terminal extension request frames were mismatched or out of order");
        }

        chunk.copy(current.buffer, offset);
        current.offset += chunk.length;

        if (current.offset !== bytes) {
            return undefined;
        }

        this.clear();
        const packet = parseToHost(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current.buffer)),
        );

        if (packet.type !== "initialize" && packet.type !== "invoke") {
            throw new Error("Only terminal extension requests may span frames");
        }

        return packet;
    }
}
