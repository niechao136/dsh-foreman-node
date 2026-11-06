import { FrameDedupe, encodeFrame, parseFrame } from "./protocol.js";
import s from "@deepseek-ai/schemastery";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
// src/client.ts
/**
* The device's outbound connection to its hub.
*
* The direction is deliberate: a device dials out, so a machine behind NAT or a company firewall can take work. The
* connection is never the device's to command — it reports what it holds, sends frames the hub asked for, and
* reconnects with exponential backoff on its own.
*
* A frame is never built here by hand: the protocol module owns every shape, so the device and the hub cannot drift.
* Nothing in this file writes a ledger, reads a policy, or opens a database — a device has none of those.
*/
const OPEN = 1;
/** A counter for frame ids; unique within one connection is enough, since the hub drops repeats by id. */
let counter = 0;
/** A fresh frame id. Time-based so two processes do not collide, with a counter so two frames in one millisecond differ. */
const nextFrameId = (prefix) => `${prefix}:${Date.now().toString(36)}:${(counter++).toString(36)}`;
/**
* Keeps one connection to the hub open, reconnecting with backoff.
*
* The class owns the socket's lifecycle and nothing else: what a frame means is the plugin's business, and what
* happens when the connection is refused is the hub's. `start` and `stop` are idempotent.
*/
var NodeClient = class {
	input;
	socket;
	stopped = false;
	reconnectTimer;
	heartbeatTimer;
	delay;
	dedupe;
	connect;
	log;
	constructor(input) {
		this.input = input;
		this.delay = input.reconnectMs ?? 1e3;
		this.dedupe = input.dedupe ?? new FrameDedupe(/* @__PURE__ */ new Set());
		this.connect = input.connect ?? ((url) => new WebSocket(url));
		this.log = input.log ?? (() => {});
	}
	/** Open the connection, or do nothing if it is already open or opening. */
	start() {
		if (this.stopped || this.socket !== void 0) return;
		this.open();
	}
	/** Close the connection and stop reconnecting; a late socket event does nothing. */
	stop() {
		this.stopped = true;
		if (this.reconnectTimer !== void 0) clearTimeout(this.reconnectTimer);
		if (this.heartbeatTimer !== void 0) clearInterval(this.heartbeatTimer);
		this.socket?.close();
		this.socket = void 0;
	}
	/** Send a frame now if the connection is open. Returns whether it went out, so a caller can retry later. */
	send(frame) {
		if (this.socket === void 0 || this.socket.readyState !== OPEN) return false;
		try {
			this.socket.send(encodeFrame(frame));
			return true;
		} catch (error) {
			this.log(`dsh-foreman-node could not send ${frame.type}: ${String(error)}`);
			return false;
		}
	}
	/** Report an outcome on an assignment, which is the only way a hub learns what a job did. */
	report(assignmentId, report) {
		const frame = {
			v: 1,
			type: "report",
			frameId: nextFrameId("report"),
			assignmentId,
			state: report.state,
			summary: report.summary,
			...report.question === void 0 ? {} : { question: report.question }
		};
		this.send(frame);
	}
	/** Whether the connection is open right now. */
	connected() {
		return this.socket !== void 0 && this.socket.readyState === OPEN;
	}
	open() {
		let socket;
		try {
			socket = this.connect(this.input.url);
		} catch (error) {
			this.log(`dsh-foreman-node could not open ${this.input.url}: ${String(error)}`);
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.addEventListener("open", () => {
			if (this.stopped) return;
			this.delay = this.input.reconnectMs ?? 1e3;
			this.hello();
			this.startHeartbeat();
		});
		socket.addEventListener("message", (event) => {
			if (this.stopped) return;
			const text = typeof event.data === "string" ? event.data : String(event.data);
			this.receive(text);
		});
		socket.addEventListener("error", () => {
			this.log("dsh-foreman-node connection error");
		});
		socket.addEventListener("close", () => {
			if (this.stopped) return;
			if (this.heartbeatTimer !== void 0) clearInterval(this.heartbeatTimer);
			this.socket = void 0;
			this.scheduleReconnect();
		});
	}
	hello() {
		const frame = {
			v: 1,
			type: "hello",
			frameId: nextFrameId("hello"),
			deviceId: this.input.deviceId,
			token: this.input.token,
			version: this.input.version,
			roots: this.input.roots(),
			running: this.input.running()
		};
		this.send(frame);
	}
	startHeartbeat() {
		if (this.heartbeatTimer !== void 0) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			const frame = {
				v: 1,
				type: "heartbeat",
				frameId: nextFrameId("heartbeat"),
				deviceId: this.input.deviceId,
				running: this.input.running().length
			};
			this.send(frame);
		}, this.input.heartbeatMs ?? 15e3);
		this.heartbeatTimer.unref?.();
	}
	receive(text) {
		let frame;
		try {
			frame = parseFrame(text);
		} catch (error) {
			this.log(`dsh-foreman-node refused a frame: ${String(error)}`);
			return;
		}
		if (!this.dedupe.take(frame.frameId)) return;
		if (frame.type === "ack") return;
		if (frame.type === "error") {
			this.log(`dsh-foreman-node was refused by the hub: ${frame.reason}`);
			return;
		}
		this.input.onFrame(frame);
	}
	/** Acknowledge a frame once its side effect is done, so the hub can stop resending it. */
	ack(frame) {
		const ack = {
			v: 1,
			type: "ack",
			frameId: nextFrameId("ack"),
			of: frame.frameId
		};
		this.send(ack);
	}
	/** Tell the hub a frame's work reached its Session, which is what lets it mark the assignment started. */
	accepted(assignmentId) {
		const frame = {
			v: 1,
			type: "accepted",
			frameId: nextFrameId("accepted"),
			assignmentId
		};
		this.send(frame);
	}
	scheduleReconnect() {
		if (this.stopped) return;
		const wait = this.delay;
		this.delay = Math.min(this.delay * 2, this.input.maxReconnectMs ?? 6e4);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			if (!this.stopped) this.open();
		}, wait);
		this.reconnectTimer.unref?.();
		this.log(`dsh-foreman-node reconnecting in ${wait} ms`);
	}
};
// src/report-tool.ts
/**
* The `foreman_report` tool a device registers on a job Session.
*
* Reporting is a hard requirement rather than a convenience: in the domain, "waiting for a person" is a structured
* fact that a report carries, and inferring it from a turn ending is an explicitly rejected approach. So a device
* states outcomes through this tool and nothing else.
*
* `dropped` is not in its enum. Deciding that work should not be done is a judgement, a device has no judgement, and
* the hub's ledger already refuses that state from a device (see the protocol). A device that believes the same thing
* must report `blocked` and let a person decide.
*
* The schema is written as JSON Schema and validated here rather than through `zod`, so this package stays free of
* runtime dependencies beyond the DSH services it is a peer plugin of.
*/
/** What a device may report; the same set the protocol's `NodeReportState` names. */
const REPORT_STATES = [
	"progress",
	"ready",
	"blocked",
	"failed"
];
/** The JSON Schema a model sees, which is also what `execute` validates against. */
const PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["state", "summary"],
	properties: {
		state: {
			type: "string",
			enum: [...REPORT_STATES],
			description: "progress while working, ready when the result is in, blocked when a person must act, failed when the work cannot be done."
		},
		summary: {
			type: "string",
			minLength: 1,
			description: "What was done, or what is needed, in one or two sentences."
		},
		question: {
			type: "string",
			minLength: 1,
			description: "One concrete question for a person, with state=blocked."
		}
	}
};
/** Thrown for arguments this tool refuses; the model sees the message and can correct itself. */
var ReportRefusal = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ReportRefusal";
	}
};
/** Validate the arguments to a report, refusing `dropped`, an unknown state, or an empty summary. */
function readReport(args) {
	const state = args["state"];
	if (typeof state !== "string") throw new ReportRefusal("state must be a string");
	if (state === "dropped") throw new ReportRefusal("a device may not report dropped: deciding that work should not be done is the hub's judgement, so report blocked instead");
	if (!REPORT_STATES.includes(state)) throw new ReportRefusal(`state must be one of ${REPORT_STATES.join(", ")}, not ${state}`);
	const summary = typeof args["summary"] === "string" ? args["summary"].trim() : "";
	if (summary === "") throw new ReportRefusal("summary must say what was done or what is needed");
	const question = typeof args["question"] === "string" ? args["question"].trim() : void 0;
	if (args["question"] !== void 0 && (question === void 0 || question === "")) throw new ReportRefusal("question must be a question when given");
	return {
		state,
		summary,
		...question === void 0 ? {} : { question }
	};
}
/**
* Build the `foreman_report` tool for one assignment.
*
* The assignment id is bound here rather than passed by the model: a job Session reports on the assignment it was
* started for, and a model should not be able to name a different one.
*/
function foremanReportTool(host, assignmentId) {
	return {
		name: "foreman_report",
		description: "Report this job to the foreman: progress, ready, blocked or failed, with a one-sentence summary and, when a person must answer, one question.",
		parameters: PARAMETERS,
		async execute(args) {
			host.report(assignmentId, readReport(args));
			return { reported: true };
		}
	};
}
// \0@oxc-project+runtime@0.156.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
// src/session.ts
/** The permission preset a job runs under: bounded to the directory the device declared. */
const JOB_PRESET = "workspace-write";
/** The Session a job runs in, named the way a hub names its own worker: `job-<assignmentId>`. */
const jobSessionId = (assignmentId) => `job-${assignmentId}`;
/** The message id of one delivery, derived from the hub's request id so a redelivery adds nothing. */
const requestMessage = (requestId) => MessageId(`dsh-foreman-node:${requestId}`);
/**
* Keeps the device's job Sessions and delivers work into them.
*
* A Session is created only when it does not exist yet, so a redelivered `assign` reuses the Session and the work
* already in it instead of starting a second one. Delivery is idempotent by request id: the hub retrying a frame
* that it never saw acknowledged cannot append the task twice.
*/
var JobSessions = class {
	ctx;
	/** Jobs by assignment id, so `running()` reports what this device actually holds rather than what it was told. */
	jobs = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
	}
	/**
	* Resolve or create the `job-<assignmentId>` Session in the given directory.
	* @returns the Session id.
	*/
	async ensure(input) {
		const id = jobSessionId(input.assignmentId);
		const workspace = await this.ctx.workspaceRegistry.create(input.directory);
		let result = await this.ctx.sessionController.resolveAgent(id);
		if ("error" in result && result.error.code === "session/not-found") {
			await this.ctx.sessionController.create({
				sessionId: id,
				workspaceId: workspace.id
			});
			result = await this.ctx.sessionController.resolveAgent(id);
		}
		if ("error" in result) throw result.error;
		await workspace.attachSession(id);
		this.ctx.permissionPresets.set(result.agent.session, JOB_PRESET);
		await this.ctx.sessionController.rename({
			sessionId: id,
			title: input.title
		});
		this.jobs.set(input.assignmentId, id);
		return id;
	}
	/**
	* Deliver a task into its job Session, once per request id.
	*
	* `queue` rather than `steer` on the first delivery: the job's task should start a turn, not interrupt one that is
	* already running. A redelivery finds the message already recorded and adds nothing.
	*/
	async deliver(sessionId, text, requestId) {
		const result = await this.ctx.sessionController.resolveAgent(sessionId);
		if ("error" in result) throw result.error;
		const agent = result.agent;
		if (await this.holds(agent, requestId)) return;
		agent.followup(freezeMessage({
			id: requestMessage(requestId),
			role: "user",
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "dsh-foreman-node",
				form: "relay"
			}
		}));
		await this.ctx.sessionPersistence.flush();
	}
	/** Whether the Session already holds the delivery for `requestId`, in its live inbox or its stored history. */
	async holds(agent, requestId) {
		const id = requestMessage(requestId);
		if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => message.id === id)) return true;
		try {
			try {
				var _usingCtx$1 = _usingCtx();
				await this.ctx.sessionPersistence.flush();
				const handle = _usingCtx$1.a(await this.ctx.sessionPersistence.open(agent.id, "read"));
				for (let offset = 0;;) {
					const { events } = await handle.read(offset, 512);
					if (events.length === 0) return false;
					for (const event of events) if (event.type === "user/message" && event.data.id === id) return true;
					offset += events.length;
				}
			} catch (_) {
				_usingCtx$1.e = _;
			} finally {
				await _usingCtx$1.d();
			}
		} catch (error) {
			this.ctx.logger.warn("dsh-foreman-node could not read %s history: %s", agent.id, String(error));
			return false;
		}
	}
	/** The assignment ids this device currently holds a job for: what a heartbeat and a reconnected hello report. */
	running() {
		return [...this.jobs.keys()];
	}
	/** Forget a job whose assignment the hub stopped, so this device stops reporting it as running. */
	forget(assignmentId) {
		this.jobs.delete(assignmentId);
	}
	/** Attach the `foreman_report` tool to a job Session, disposed with it. */
	reportTools(agent, assignmentId, onReport) {
		const registrar = agent.ctx.tools;
		const tool = foremanReportTool({ report: onReport }, assignmentId);
		registrar.register({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			execute: (args, execution) => tool.execute(args, execution)
		});
	}
};
// src/index.ts
/** Version reported in the hello, so the hub can tell which device build is talking. */
const VERSION = "0.1.0";
/**
* Configuration of one device, from the `dsh-foreman-node` entry in the profile's patch.
*
* The annotation names the schema type through the global `Schemastery` namespace rather than letting it be inferred:
* an inferred type here names a `cosmokit` symbol the emitted declaration cannot reference portably.
*/
const Config = s.object({
	url: s.string().required().description("The hub's address, such as wss://foreman.example.com. The device dials out to it."),
	deviceId: s.string().required().description("This device's id, as registered on the hub with `Devices.add`."),
	token: s.string().required().role("secret").description("This device's token; it is sent in the hello frame and nowhere else."),
	roots: s.array(s.object({
		project: s.string().required(),
		path: s.string().required()
	})).default([]).description("Projects this device can work on: a logical name and this machine's own absolute path, kept verbatim."),
	heartbeatMs: s.natural().default(15e3).description("How often to tell the hub this device is alive, in milliseconds."),
	reconnectMs: s.natural().default(1e3).description("Delay before the first reconnect attempt, in milliseconds.")
});
const name = "dsh-foreman-node";
/** DSH services a job needs; all are the host's own, and none is a foreman one. */
const inject = [
	"sessionController",
	"sessionPersistence",
	"workspaceRegistry",
	"permissionPresets",
	"tools",
	"agents"
];
/**
* Start the device.
*
* The plugin returns once the connection is attempted, not once it succeeds: a device must boot and stay usable
* while its hub is unreachable, and the client keeps retrying in the background.
*/
async function apply(ctx, config) {
	const jobs = new JobSessions(ctx);
	const client = new NodeClient({
		url: config.url,
		deviceId: config.deviceId,
		token: config.token,
		version: VERSION,
		roots: () => config.roots.map((root) => ({
			project: root.project,
			path: root.path
		})),
		running: () => jobs.running(),
		heartbeatMs: config.heartbeatMs,
		reconnectMs: config.reconnectMs,
		log: (text) => ctx.logger.warn("%s", text),
		onFrame: (frame) => {
			receive(ctx, jobs, client, frame);
		}
	});
	client.start();
	ctx.effect(() => () => {
		client.stop();
	});
	ctx.logger.info("dsh-foreman-node %s is dialling %s as %s", VERSION, config.url, config.deviceId);
}
/**
* Handle one frame from the hub.
*
* `assign` creates or reuses the job Session and delivers the task; `input` steers more text into the same Session;
* `stop` ends the job. Each is acknowledged so the hub stops resending it, and each is idempotent on this side, so a
* redelivery after a dropped ack does no harm.
*/
async function receive(ctx, jobs, client, frame) {
	try {
		if (frame.type === "assign") {
			const sessionId = await jobs.ensure({
				assignmentId: frame.assignmentId,
				directory: frame.directory,
				title: `job ${frame.assignmentId}`
			});
			await jobs.deliver(sessionId, frame.text, frame.frameId);
			client.accepted(frame.assignmentId);
			client.ack(frame);
			return;
		}
		if (frame.type === "input") {
			const sessionId = `job-${frame.assignmentId}`;
			await jobs.deliver(sessionId, frame.text, frame.frameId);
			client.ack(frame);
			return;
		}
		if (frame.type === "stop") {
			jobs.forget(frame.assignmentId);
			client.ack(frame);
		}
	} catch (error) {
		ctx.logger.warn("dsh-foreman-node could not apply a %s frame: %s", frame.type, String(error));
		if (frame.type === "assign" || frame.type === "input") client.report(frame.assignmentId, {
			state: "blocked",
			summary: `this device could not start the job: ${String(error)}`
		});
	}
}
export { Config, JobSessions, NodeClient, REPORT_STATES, VERSION, apply, foremanReportTool, inject, name };
