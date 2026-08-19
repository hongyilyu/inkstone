// TickTick OpenAPI WRITE-contract spike (ticktick-writes plan, W1 — the
// go/no-go gate). Probes `POST /open/v1/task` create semantics against the
// DISPOSABLE smoke account: response shape, duplicate double-POST, Inbox
// default, due-tuple round-trip, the note field, the per-status outcome-
// classification table, and a latency sample. MANUAL DISPATCH ONLY — no
// workflow schedules this; run it by hand with the smoke-account token:
//
//   TICKTICK_ACCESS_TOKEN=... node scripts/ticktick-write-spike.mjs
//
// NON-CAPTURING (live-smoke privacy posture, same as ticktick-live-smoke.mjs):
// prints statuses, counts, booleans, field-name sets, and id/projectId SHAPES
// only — never a response body, never a header value beyond rate-limit key
// NAMES, never the token. Staged titles are synthetic (`inkstone-w1-…`), and
// the spike DELETES its staged rows via the API before exiting (tooling-only
// capability — the product never deletes).

const BASE = "https://api.ticktick.com";
const RUN_NONCE = `w1-${Date.now().toString(36)}`;

const token = process.env.TICKTICK_ACCESS_TOKEN;
if (!token) {
	console.error(
		"TICKTICK_ACCESS_TOKEN is not set (disposable smoke-account token)",
	);
	process.exit(1);
}

/** Staged `{projectId, taskId}` pairs, deleted in the cleanup pass. */
const staged = [];
/** Latency samples (ms) for successful creates. */
const latencies = [];

/** One bounded request. Returns `{status, headers, bodyText, ms}` — never
 * throws on HTTP status (the spike CLASSIFIES statuses); throws only on
 * transport failure. */
async function request(method, path, body, overrideToken) {
	const started = Date.now();
	const init = {
		method,
		headers: {
			authorization: `Bearer ${overrideToken ?? token}`,
			"content-type": "application/json",
		},
		signal: AbortSignal.timeout(30_000),
	};
	if (body !== undefined) init.body = JSON.stringify(body);
	const response = await fetch(`${BASE}${path}`, init);
	const bodyText = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		bodyText,
		ms: Date.now() - started,
	};
}

/** Decode a create/read body, returning `null` on undecodable JSON. */
function decode(bodyText) {
	try {
		return JSON.parse(bodyText);
	} catch {
		return null;
	}
}

/** Rate-limit-ish header NAMES present on a response (values never printed). */
function rateLimitHeaderNames(headers) {
	const names = [];
	headers.forEach((_value, name) => {
		if (/rate.?limit|retry-after/i.test(name)) names.push(name);
	});
	return names;
}

/** Create one task, record it for cleanup, and report shape facts. */
async function create(label, payload) {
	const r = await request("POST", "/open/v1/task", payload);
	const decoded = decode(r.bodyText);
	const id = typeof decoded?.id === "string" ? decoded.id : null;
	const projectId =
		typeof decoded?.projectId === "string" ? decoded.projectId : null;
	if (r.status >= 200 && r.status < 300) {
		latencies.push(r.ms);
		if (id && projectId) staged.push({ projectId, taskId: id });
	}
	console.log(
		`create[${label}]: status=${r.status} decodable=${decoded !== null} ` +
			`id_nonempty=${!!id} projectId_present=${!!projectId} ` +
			`projectId_inbox_prefixed=${projectId?.startsWith("inbox") ?? false} ` +
			`keys=[${decoded ? Object.keys(decoded).sort().join(",") : ""}] ms=${r.ms}`,
	);
	return { ...r, decoded, id, projectId };
}

/** The filter read (the production read path's request), for round-trip checks. */
async function filterTasks() {
	const r = await request("POST", "/open/v1/task/filter", { status: [0] });
	if (r.status !== 200) throw new Error(`filter read: HTTP ${r.status}`);
	const rows = decode(r.bodyText);
	if (!Array.isArray(rows)) throw new Error("filter read: body not an array");
	return rows;
}

/** Probe an error status; print status + decodability + rate-limit header
 * names only (never bodies). */
async function probeError(label, method, path, body, overrideToken) {
	try {
		const r = await request(method, path, body, overrideToken);
		const decoded = decode(r.bodyText);
		// A 2xx here means the probe unexpectedly CREATED something — stage it
		// for cleanup rather than leaking a row.
		if (
			r.status < 300 &&
			typeof decoded?.id === "string" &&
			typeof decoded?.projectId === "string"
		) {
			staged.push({ projectId: decoded.projectId, taskId: decoded.id });
		}
		console.log(
			`probe[${label}]: status=${r.status} decodable=${decoded !== null} ` +
				`error_keys=[${decoded && r.status >= 400 ? Object.keys(decoded).sort().join(",") : ""}] ` +
				`ratelimit_headers=[${rateLimitHeaderNames(r.headers).join(",")}]`,
		);
		return r.status;
	} catch (error) {
		console.log(`probe[${label}]: transport=${error.name}`);
		return null;
	}
}

async function main() {
	// ── P1: create happy path + response shape ────────────────────────────────
	const p1 = await create("minimal-titled", {
		title: `inkstone-${RUN_NONCE}-p1`,
	});

	// ── P2: duplicate double-POST (same exact payload twice) ─────────────────
	const dupPayload = { title: `inkstone-${RUN_NONCE}-dup` };
	const d1 = await create("dup-first", dupPayload);
	const d2 = await create("dup-second", dupPayload);
	console.log(
		`duplicate: distinct_ids=${!!d1.id && !!d2.id && d1.id !== d2.id}`,
	);

	// ── P3: due tuples (all-day + timed + timezone) ───────────────────────────
	// Shapes mirror what the filter read returns (wire.rs contract cases).
	const allDay = await create("due-all-day", {
		title: `inkstone-${RUN_NONCE}-allday`,
		dueDate: "2026-09-01T07:00:00.000+0000",
		isAllDay: true,
		timeZone: "America/Los_Angeles",
	});
	const timed = await create("due-timed", {
		title: `inkstone-${RUN_NONCE}-timed`,
		dueDate: "2026-09-01T17:30:00.000+0000",
		isAllDay: false,
		timeZone: "America/Los_Angeles",
	});

	// ── P4: the note field — content vs desc ─────────────────────────────────
	const noteContent = await create("note-content", {
		title: `inkstone-${RUN_NONCE}-note-content`,
		content: `note-body-${RUN_NONCE}`,
	});
	const noteDesc = await create("note-desc", {
		title: `inkstone-${RUN_NONCE}-note-desc`,
		desc: `desc-body-${RUN_NONCE}`,
	});

	// ── Read-back via the filter read ─────────────────────────────────────────
	const rows = await filterTasks();
	const byId = (id) => rows.find((row) => row.id === id);

	const p1Row = p1.id ? byId(p1.id) : undefined;
	console.log(
		`readback[p1]: found=${!!p1Row} projectId_inbox=${p1Row?.projectId?.startsWith("inbox") ?? false}`,
	);
	const dupRows = rows.filter((row) => row.title === dupPayload.title);
	console.log(`readback[dup]: rows_with_dup_title=${dupRows.length}`);

	const allDayRow = allDay.id ? byId(allDay.id) : undefined;
	console.log(
		`readback[all-day]: found=${!!allDayRow} ` +
			`dueDate_match=${allDayRow?.dueDate === "2026-09-01T07:00:00.000+0000"} ` +
			`isAllDay=${allDayRow?.isAllDay} timeZone_match=${allDayRow?.timeZone === "America/Los_Angeles"} ` +
			`startDate_equals_due=${allDayRow?.startDate === allDayRow?.dueDate}`,
	);
	const timedRow = timed.id ? byId(timed.id) : undefined;
	console.log(
		`readback[timed]: found=${!!timedRow} ` +
			`dueDate_match=${timedRow?.dueDate === "2026-09-01T17:30:00.000+0000"} ` +
			`isAllDay=${timedRow?.isAllDay} timeZone_match=${timedRow?.timeZone === "America/Los_Angeles"}`,
	);

	const contentRow = noteContent.id ? byId(noteContent.id) : undefined;
	const descRow = noteDesc.id ? byId(noteDesc.id) : undefined;
	console.log(
		`readback[note]: content_roundtrips=${contentRow?.content === `note-body-${RUN_NONCE}`} ` +
			`desc_roundtrips_as_desc=${descRow?.desc === `desc-body-${RUN_NONCE}`} ` +
			`desc_surfaces_as_content=${descRow?.content === `desc-body-${RUN_NONCE}`}`,
	);

	// ── P5: the outcome-classification table, per inducible status ───────────
	// 401: a wrong bearer.
	await probeError(
		"401-bad-token",
		"POST",
		"/open/v1/task",
		{
			title: "x",
		},
		"invalid-token",
	);
	// Missing title / empty payload — which 4xx does a rejected create wear?
	await probeError("create-empty-payload", "POST", "/open/v1/task", {});
	// Type-violating payload.
	await probeError("create-title-not-string", "POST", "/open/v1/task", {
		title: 12345,
	});
	// Malformed due date.
	await probeError("create-bad-duedate", "POST", "/open/v1/task", {
		title: `inkstone-${RUN_NONCE}-baddate`,
		dueDate: "not-a-date",
	});
	// Foreign/unknown projectId (does it 4xx, or silently re-file?).
	await probeError("create-bogus-projectid", "POST", "/open/v1/task", {
		title: `inkstone-${RUN_NONCE}-bogusproj`,
		projectId: "nonexistent-project-id-000",
	});
	// 404 family: read a bogus task.
	await probeError(
		"404-get-bogus-task",
		"GET",
		"/open/v1/project/inbox/task/nonexistent000",
	);
	// 413 family: an oversized create (1 MiB title).
	await probeError("oversized-title", "POST", "/open/v1/task", {
		title: `inkstone-${RUN_NONCE}-big-${"x".repeat(1024 * 1024)}`,
	});

	// ── P7: latency sample ────────────────────────────────────────────────────
	const sorted = [...latencies].sort((a, b) => a - b);
	console.log(
		`latency(create, ms): n=${sorted.length} min=${sorted[0]} ` +
			`median=${sorted[Math.floor(sorted.length / 2)]} max=${sorted[sorted.length - 1]}`,
	);

	// ── Cleanup: delete every staged row via the API ──────────────────────────
	let deleted = 0;
	for (const { projectId, taskId } of staged) {
		const r = await request(
			"DELETE",
			`/open/v1/project/${projectId}/task/${taskId}`,
		);
		if (r.status >= 200 && r.status < 300) deleted += 1;
		else console.log(`cleanup: delete status=${r.status}`);
	}
	const after = await filterTasks();
	const leaked = after.filter((row) =>
		row.title?.startsWith(`inkstone-${RUN_NONCE}`),
	).length;
	console.log(
		`cleanup: staged=${staged.length} deleted=${deleted} leaked_after_delete=${leaked}`,
	);
	if (leaked > 0) process.exitCode = 1;
}

try {
	await main();
	console.log("write spike: DONE");
} catch (error) {
	console.error(`write spike: FAIL — ${error.message}`);
	process.exitCode = 1;
}
