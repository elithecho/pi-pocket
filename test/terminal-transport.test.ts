/** Wire frames, full logical request bounds, and sender admission are independent safeguards. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
    MAX_PACKET_BYTES,
    MAX_REQUEST_BYTES,
    parseFromHost,
    parseHostSnapshot,
    parseToHost,
    type HostSnapshot,
    type ToHost,
} from "../src/server/terminal/protocol.ts";
import { RequestBudget } from "../src/server/terminal/request-budget.ts";
import {
    encodeRequest,
    RequestDecoder,
    REQUEST_CHUNK_BYTES,
    type RequestChunk,
} from "../src/server/terminal/transport.ts";

function snapshot(padding = ""): HostSnapshot {
    const entry = { type: "session", id: "fixture", timestamp: "2026-01-01", padding };

    return {
        entries: [entry],
        busy: false,
        pending: false,
        nativeTools: [],
        activeTools: [],
        thinkingLevel: "off",
        systemPrompt: "",
    };
}

function request(view = snapshot()): ToHost {
    return {
        type: "invoke",
        id: "fixture",
        operation: { kind: "command", name: "goal", args: "" },
        snapshot: view,
    };
}

const large = request(snapshot('🙂\n\\"'.repeat(900_000)));
const frames = [...encodeRequest(large)] as RequestChunk[];

function decode(parts: unknown[]): ToHost | undefined {
    const receiver = new RequestDecoder();
    let result: ToHost | undefined;

    for (const [index, part] of parts.entries()) {
        result = receiver.receive(part);

        if (index < parts.length - 1) {
            assert.equal(result, undefined, "no partial request may be dispatched");
        }
    }

    return result;
}

test("small/control packets pass directly, while large multibyte requests roundtrip bounded frames", () => {
    for (const packet of [request(), { type: "ack", through: 1 }, { type: "close" }] as ToHost[]) {
        assert.deepEqual([...encodeRequest(packet)], [packet]);
        assert.deepEqual(new RequestDecoder().receive(packet), packet);
    }

    assert.ok(frames.length > 1);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > MAX_PACKET_BYTES);
    assert.deepEqual(
        parseHostSnapshot((large as Extract<ToHost, { type: "invoke" }>).snapshot),
        (large as Extract<ToHost, { type: "invoke" }>).snapshot,
    );

    for (const frame of frames) {
        assert.equal(frame.type, "request-chunk");
        assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= MAX_PACKET_BYTES);
        assert.ok(Buffer.from(frame.data, "base64").length <= REQUEST_CHUNK_BYTES);
    }

    assert.deepEqual(decode(frames), large);
    assert.throws(() => new RequestDecoder().receive(large), /packet.*limit/);
});

test("logical requests accept exactly 64 MiB and reject one more byte without weakening wire limits", () => {
    const packet = request();
    const overhead = Buffer.byteLength(JSON.stringify(packet));
    const exactWire = request(snapshot("x".repeat(MAX_PACKET_BYTES - overhead)));
    const overWire = request(snapshot("x".repeat(MAX_PACKET_BYTES - overhead + 1)));

    assert.equal([...encodeRequest(exactWire)].length, 1);
    assert.deepEqual(new RequestDecoder().receive(exactWire), exactWire);
    assert.throws(() => new RequestDecoder().receive(overWire), /packet.*limit/);
    assert.deepEqual(decode([...encodeRequest(overWire)]), overWire);
    const exact = request(snapshot("x".repeat(MAX_REQUEST_BYTES - overhead)));

    assert.equal(Buffer.byteLength(JSON.stringify(exact)), MAX_REQUEST_BYTES);
    assert.deepEqual(decode([...encodeRequest(exact)]), exact);
    const excessive = request(snapshot("x".repeat(MAX_REQUEST_BYTES - overhead + 1)));

    assert.throws(() => parseToHost(excessive), /request.*64 MiB.*limit/);
    assert.throws(() => [...encodeRequest(excessive)], /request.*64 MiB.*limit/);
    assert.throws(
        () => parseToHost({ type: "answer", id: "dialog", value: "x".repeat(MAX_PACKET_BYTES) }),
        /packet.*limit/,
    );
    assert.throws(
        () =>
            parseFromHost({ type: "error", id: "fixture", message: "x".repeat(MAX_PACKET_BYTES) }),
        /packet.*limit/,
    );
});

test("the entire recursive operation/envelope remains bounded to 8 MiB independently of snapshots", () => {
    for (const operation of [
        {
            kind: "tool",
            name: "example",
            callId: "call",
            args: { a: "x".repeat(5_000_000), b: "y".repeat(5_000_000) },
        },
        { kind: "event", event: { a: "x".repeat(5_000_000), b: "y".repeat(5_000_000) } },
    ]) {
        const packet = { ...request(), operation };

        assert.throws(() => parseToHost(packet), /packet.*limit/);
        assert.throws(() => [...encodeRequest(packet as ToHost)], /packet.*limit/);
    }
});

test("malformed frame sizes, encodings and fields are rejected before allocating a transfer", () => {
    const first = frames[0]!;

    for (const change of [
        { bytes: MAX_REQUEST_BYTES + 1 },
        { bytes: MAX_PACKET_BYTES },
        { bytes: 1.5 },
        { offset: -1 },
        { offset: REQUEST_CHUNK_BYTES },
        { offset: NaN },
        { transfer: "not-a-transfer-id" },
        { data: first.data.slice(0, -4) },
        { data: first.data + "\n" },
        { data: "!".repeat(first.data.length) },
        { data: "x".repeat(MAX_PACKET_BYTES) },
        { extra: true },
    ]) {
        const receiver = new RequestDecoder();

        assert.throws(() => receiver.receive({ ...first, ...change }));
        assert.deepEqual(receiver.receive({ type: "close" }), { type: "close" });
    }
});

test("duplicate, skipped, interleaved and same-size mixed transfers never dispatch, and reset releases state", () => {
    const first = frames[0]!;
    const second = frames[1]!;

    for (const invalid of [
        first,
        { ...second, offset: second.offset + REQUEST_CHUNK_BYTES },
        { ...second, bytes: second.bytes + 1 },
        { ...second, transfer: randomUUID() },
        { type: "ack", through: 0 },
    ]) {
        const receiver = new RequestDecoder();

        assert.equal(receiver.receive(first), undefined);
        assert.throws(() => receiver.receive(invalid));
        assert.equal(receiver.receive(first), undefined, "errors discard the old transfer");
        receiver.clear();
        assert.deepEqual(receiver.receive({ type: "ack", through: 0 }), {
            type: "ack",
            through: 0,
        });
    }

    const receiver = new RequestDecoder();

    assert.equal(receiver.receive(first), undefined);
    assert.deepEqual(receiver.receive({ type: "close" }), { type: "close" });
    assert.throws(() => receiver.receive(second), /byte zero/);
});

test("fully assembled invalid JSON, schema or UTF-8 fails instead of reaching dispatch", () => {
    const bytes = Buffer.byteLength(JSON.stringify(large));

    for (const source of [
        Buffer.alloc(bytes, 0xff),
        Buffer.from("{" + " ".repeat(bytes - 1)),
        Buffer.from(JSON.stringify({ type: "bogus", pad: "x".repeat(bytes) })),
        Buffer.from(JSON.stringify({ type: "close", pad: "x".repeat(bytes) })),
    ]) {
        const transfer = randomUUID();
        const parts: RequestChunk[] = [];

        for (let offset = 0; offset < source.length; offset += REQUEST_CHUNK_BYTES) {
            parts.push({
                type: "request-chunk",
                transfer,
                bytes: source.length,
                offset,
                data: source.subarray(offset, offset + REQUEST_CHUNK_BYTES).toString("base64"),
            });
        }

        assert.throws(() => decode(parts));
    }
});

test("aggregate reservations reject before queuing and release on shrink, failure or repeated disposal", () => {
    const budget = new RequestBudget();
    const leases = Array.from({ length: 4 }, () => budget.reserve());

    assert.throws(() => budget.reserve(), /memory is busy/);
    leases[0]!.resize(MAX_REQUEST_BYTES / 2);
    assert.throws(() => budget.reserve(), /memory is busy/);
    leases[1]!.resize(MAX_REQUEST_BYTES / 2);
    const next = budget.reserve();

    assert.throws(() => next.resize(MAX_REQUEST_BYTES + 1), /reservation/);
    assert.throws(() => next.resize(-1), /reservation/);
    assert.throws(() => next.resize(NaN), /reservation/);
    next.release();
    next.release();
    assert.throws(() => next.resize(0), /reservation/);

    for (const lease of leases) {
        lease.release();
    }

    const restored = Array.from({ length: 4 }, () => budget.reserve());

    assert.throws(() => budget.reserve(), /memory is busy/);
    restored.forEach((lease) => lease.release());
});
