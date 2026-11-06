// src/protocol.ts
/**
* The foreman protocol: one JSON frame per WebSocket text message, versioned by `v`.
*
* This file is the only definition of a frame. `dsh-foreman` (the hub) depends on
* this package and imports it, so the two sides cannot drift; nothing here may
* import a DSH service, the core domain, or a database.
*/
/** Bumped whenever a frame's shape changes incompatibly; a peer on another version is refused at handshake. */
const FOREMAN_PROTOCOL_VERSION = 1;
/** Largest frame accepted, in bytes of UTF-8. A larger one is refused, never truncated. */
const MAX_FRAME_BYTES = 262144;
/** A frame the receiver cannot accept: wrong version, unknown type, malformed JSON, or over the size cap. */
var FrameError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "FrameError";
	}
};
const TYPES = /* @__PURE__ */ new Set([
	"hello",
	"heartbeat",
	"assign",
	"input",
	"stop",
	"accepted",
	"report",
	"ack",
	"error"
]);
function encodeFrame(frame) {
	return JSON.stringify(frame);
}
/**
* Parses one frame, refusing anything this build cannot honour.
* @throws FrameError for oversized text, malformed JSON, another protocol version, or an unknown type.
*/
function parseFrame(text) {
	const size = Buffer.byteLength(text, "utf8");
	if (size > 262144) throw new FrameError(`frame too large: ${size} bytes, limit ${MAX_FRAME_BYTES}`);
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new FrameError(`malformed frame: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof value !== "object" || value === null) throw new FrameError("a frame must be a JSON object");
	const frame = value;
	const version = frame["v"];
	if (version !== 1) throw new FrameError(`unsupported protocol version ${String(version)}; this build speaks 1`);
	const type = frame["type"];
	if (typeof type !== "string" || !TYPES.has(type)) throw new FrameError(`unknown frame type ${String(type)}`);
	if (typeof frame["frameId"] !== "string" || frame["frameId"] === "") throw new FrameError("a frame needs a frameId");
	return frame;
}
/** Remembers the frame ids a peer has already acted on, so a retried frame does nothing twice. */
var FrameDedupe = class {
	seen;
	constructor(seen = /* @__PURE__ */ new Set()) {
		this.seen = seen;
	}
	/** Returns true the first time a frame id is seen, false for a repeat. */
	take(frameId) {
		if (this.seen.has(frameId)) return false;
		this.seen.add(frameId);
		return true;
	}
};
export { FOREMAN_PROTOCOL_VERSION, FrameDedupe, FrameError, MAX_FRAME_BYTES, encodeFrame, parseFrame };
