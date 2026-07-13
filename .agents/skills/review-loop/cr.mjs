#!/usr/bin/env node
// CodeRabbit read-side helpers for the review-loop skill.
// Dependency-free: shells to `gh` + parses. Read-only except `resolve`.
//
//   node cr.mjs findings <pr>                 → unresolved, non-outdated CR threads (JSON)
//   node cr.mjs await-review <pr> <headSha> [maxWaitMin=480] [pollMin=5]
//   node cr.mjs resolve <threadId>            → resolve one review thread
//
// `findings` and `resolve` are the read/resolve seam. `await-review` also
// writes: CodeRabbit AUTO-reviews on this repo (push/open trigger it), and
// reports a CLEAN review as an inline walkthrough comment naming HEAD — not a
// formal review object — so await-review accepts EITHER signal (see
// reviewedHead) and posts `@coderabbitai review` only as a fallback nudge (once
// per rate-limit window). CodeRabbit throttles nearly every PR here (9-50 min
// windows), so surviving the throttle while watching for the review is its
// whole job. Run it backgrounded: a single wait can exceed the foreground Bash
// 10-min cap.
//
// Rate-limit handling: CodeRabbit's notice says e.g. "Next review available
// in: **9 minutes**" (bold-wrapped). We parse the actual stated time, add a
// 30s buffer + 1-5 min random jitter, then sleep the full duration before
// re-triggering. The jitter prevents instant re-throttle from per-user
// contention (the limit is per-user across all PRs, not per-PR) and
// desynchronizes concurrent review-loop sessions.

import { execFileSync } from "node:child_process";

function gh(args, { json = false } = {}) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function repo() {
  const { owner, name } = gh(["repo", "view", "--json", "owner,name"], { json: true });
  return { owner: owner.login, name };
}

// --- severity taxonomy ------------------------------------------------------
// CodeRabbit encodes the kind in the first line of a finding body, e.g.
//   _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_
// We surface the raw badges and a coarse `kind`; the agent does real triage.
function classify(body) {
  const firstLine = (body || "").split("\n").find((l) => l.trim()) ?? "";
  const badges = firstLine.includes("|") || firstLine.includes("_")
    ? firstLine.split("|").map((s) => s.replace(/[_*`]/g, "").trim()).filter(Boolean)
    : [];
  const lc = firstLine.toLowerCase();
  let kind = "other";
  if (lc.includes("potential issue") || lc.includes("critical") || lc.includes("major")) kind = "issue";
  else if (lc.includes("refactor")) kind = "refactor";
  else if (lc.includes("nitpick") || lc.includes("nit")) kind = "nit";
  else if (lc.includes("minor")) kind = "minor";
  // actionable = something the loop should verify+fix; nits are advisory.
  const actionable = kind === "issue" || kind === "refactor";
  return { badges, kind, actionable };
}

function titleOf(body) {
  const m = (body || "").match(/\*\*(.+?)\*\*/s);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function fencedBlock(body, lang) {
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "i");
  const m = (body || "").match(re);
  return m ? m[1].trimEnd() : "";
}

function aiPrompt(body) {
  // The "🤖 Prompt for AI Agents" <details> wraps a plain ``` block.
  const idx = (body || "").indexOf("Prompt for AI Agents");
  if (idx === -1) return "";
  const after = body.slice(idx);
  const m = after.match(/```\n([\s\S]*?)```/);
  return m ? m[1].trim() : "";
}

async function findings(pr) {
  const { owner, name } = repo();
  const data = gh(
    [
      "api", "graphql",
      "-f", "query=query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:1){nodes{databaseId author{login} body createdAt}}}}}}}",
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `pr=${pr}`,
    ],
    { json: true },
  );
  const node = data.data.repository.pullRequest;
  const head = node.headRefOid;
  const threads = node.reviewThreads.nodes
    .filter((t) => !t.isResolved && !t.isOutdated)
    .map((t) => {
      const c = t.comments.nodes[0];
      if (!c || (c.author?.login ?? "") !== "coderabbitai") return null;
      return {
        threadId: t.id,
        commentId: c.databaseId, // REST id for replies
        path: t.path,
        line: t.line,
        ...classify(c.body),
        title: titleOf(c.body),
        suggestedDiff: fencedBlock(c.body, "diff"),
        aiPrompt: aiPrompt(c.body),
        body: c.body,
      };
    })
    .filter(Boolean);
  return { head, count: threads.length, actionable: threads.filter((t) => t.actionable).length, threads };
}

function log(msg) {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function issueComments(owner, name, pr) {
  return gh(["api", `repos/${owner}/${name}/issues/${pr}/comments`, "--paginate"], { json: true });
}

// CodeRabbit's rate-limit notice is an issue comment marked with this HTML
// comment, e.g. "More reviews will be available in 33 minutes and 16 seconds."
// It posts a FRESH comment each time (created == updated), so the latest one
// by created_at is the active window. Returns {liftMs} or null.
function latestRateLimit(comments) {
  const rl = comments
    .filter(
      (c) =>
        (c.user?.login ?? "") === "coderabbitai[bot]" &&
        (c.body || "").includes("rate limited by coderabbit.ai"),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!rl) return null;
  return { liftMs: Date.parse(rl.created_at) + parseWindowMs(rl.body), createdAt: rl.created_at };
}

function parseWindowMs(body) {
  // Strip markdown bold/italic markers so "**9 minutes**" parses as "9 minutes".
  const plain = (body || "").replace(/\*{1,2}/g, "");
  const grab = (re) => {
    const m = plain.match(re);
    return m ? Number(m[1]) : 0;
  };
  const ms =
    grab(/(\d+)\s*hours?/i) * 3600000 +
    grab(/(\d+)\s*minutes?/i) * 60000 +
    grab(/(\d+)\s*seconds?/i) * 1000;
  // Jitter 1-5 min on top of the parsed window + 30s buffer: avoids re-triggering
  // at the exact lift moment (which often re-throttles due to per-user contention
  // from other PRs). The jitter also desynchronizes multiple concurrent review-loop
  // sessions competing for one rate-limit budget.
  const jitterMs = (60 + Math.floor(Math.random() * 240)) * 1000; // 1-5 min in seconds
  return ms + 30000 + jitterMs;
}

function triggerReview(owner, name, pr) {
  gh(["api", `repos/${owner}/${name}/issues/${pr}/comments`, "-f", "body=@coderabbitai review"]);
}

function reviewedHead(owner, name, pr, headSha, comments) {
  // CodeRabbit signals "I reviewed headSha" in one of TWO ways, depending on
  // whether it found anything — and the loop must accept BOTH or it hangs:
  //
  // 1. Formal review object with commit_id == headSha. Emitted when CodeRabbit
  //    leaves inline thread comments. A review of an EARLIER commit does not
  //    count — that's a stale review of a superseded push.
  const reviews = gh(["api", `repos/${owner}/${name}/pulls/${pr}/reviews`], { json: true });
  if (reviews.some((r) => (r.user?.login ?? "") === "coderabbitai[bot]" && r.commit_id === headSha)) {
    return true;
  }
  // 2. A walkthrough / summary ISSUE-COMMENT that names headSha. On a CLEAN
  //    review ("No actionable comments were generated 🎉") CodeRabbit posts NO
  //    formal review object — only this auto-summary, whose "Commits … between
  //    <base> and <head>" line carries the reviewed head SHA verbatim. This repo
  //    also AUTO-reviews on push/open, so the summary often lands before our
  //    explicit trigger. Without this branch the loop spins forever on a clean
  //    PR waiting for a review object that never comes — the inline comment IS
  //    the verdict. (The findings query separately confirms zero open threads.)
  const cs = comments ?? issueComments(owner, name, pr);
  return cs.some(
    (c) => (c.user?.login ?? "") === "coderabbitai[bot]" && (c.body || "").includes(headSha),
  );
}

// Block until CodeRabbit reviews `headSha`, surviving its rate limit.
//
// The limit is per-USER, not per-PR ("you've reached your PR review rate
// limit"), so when several PRs are in flight they compete for one budget: a
// window lifting does NOT guarantee THIS PR gets served — another PR can take
// the slot and re-throttle us. So we ride out repeated windows, and the sleep
// is DYNAMIC: when throttled we sleep the window's actual remaining time (from
// CodeRabbit's "available in N minutes" notice, rounded up to the minute)
// instead of waking uselessly every few minutes. `maxWaitMin` is generous
// (default 8h) because riding out several windows is the expected case.
//
// CodeRabbit AUTO-reviews on this repo (push/open trigger it), and reports a
// CLEAN review as an inline walkthrough comment naming headSha — see
// reviewedHead's signal #2. So the auto-review often lands BEFORE our explicit
// `@coderabbitai review`, and `reviewedHead` returns ready off that comment.
// We still post the explicit trigger as a FALLBACK (auto-review can be paused,
// or a re-push needs a nudge) — but it is no longer the only path to a review,
// and a clean PR no longer hangs waiting for a formal review object. The
// trigger rule `lastTrigger < max(lift, sessionStart)` fires it exactly once
// per window AND posts it immediately on entry when there's no active throttle.
// MUST be run backgrounded — a single wait routinely exceeds the foreground
// Bash 10-min cap.
async function awaitReview(pr, headSha, maxWaitMin = 480, pollMin = 5) {
  const { owner, name } = repo();
  const MAX_SLEEP_MS = 60 * 60000; // sanity bound on any single sleep (guards a mis-parsed window)
  const sessionStart = Date.now();
  const deadline = sessionStart + maxWaitMin * 60000;
  let lastTriggerMs = 0;

  for (;;) {
    // One issue-comments fetch per tick, reused for both the completion check
    // (walkthrough comment naming headSha) and the rate-limit window.
    const comments = issueComments(owner, name, pr);
    if (reviewedHead(owner, name, pr, headSha, comments)) {
      log(`reviewed ${headSha.slice(0, 8)} — ready`);
      process.stdout.write(JSON.stringify({ ready: true, headSha }) + "\n");
      return 0;
    }
    if (Date.now() >= deadline) {
      log(`timeout after ${maxWaitMin} min — CodeRabbit never reviewed ${headSha.slice(0, 8)}`);
      process.stdout.write(JSON.stringify({ ready: false, headSha, reason: "timeout" }) + "\n");
      return 1;
    }

    const rl = latestRateLimit(comments);
    const now = Date.now();
    const liftMs = rl ? rl.liftMs : 0; // 0 ⇒ never throttled ⇒ liftable now

    let sleepMs;
    if (now < liftMs) {
      // Throttled: sleep the window's real remaining time (which includes the
      // jitter from parseWindowMs). The jitter means we wake 1-5 min AFTER the
      // stated lift, avoiding instant re-throttle from per-user contention.
      sleepMs = Math.min(liftMs - now, MAX_SLEEP_MS);
      const remainMin = Math.ceil(sleepMs / 60000);
      const liftTime = new Date(liftMs).toISOString().slice(11, 16);
      log(`throttled — waiting ~${remainMin} min (re-trigger ~${liftTime} UTC, includes jitter)`);
    } else if (lastTriggerMs < Math.max(liftMs, sessionStart)) {
      // Not throttled, no trigger pending for this window → post the explicit
      // `@coderabbitai review` as a fallback nudge (auto-review usually fires
      // first, but a paused auto-review or a re-push may need it).
      triggerReview(owner, name, pr);
      lastTriggerMs = now;
      log(rl ? "throttle lifted — posted @coderabbitai review" : "posted @coderabbitai review (fallback nudge)");
      sleepMs = pollMin * 60000; // short cadence to catch the review landing OR a fresh throttle notice
    } else {
      // Triggered; waiting for CodeRabbit to either post the review or re-throttle us.
      log("review pending (trigger sent, awaiting CodeRabbit)");
      sleepMs = pollMin * 60000;
    }

    sleepMs = Math.min(sleepMs, MAX_SLEEP_MS, deadline - Date.now());
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  }
}

function resolve(threadId) {
  gh([
    "api", "graphql",
    "-f", "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
    "-f", `id=${threadId}`,
  ]);
  process.stdout.write(JSON.stringify({ resolved: threadId }) + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "findings":
    process.stdout.write(JSON.stringify(await findings(Number(rest[0])), null, 2) + "\n");
    break;
  case "await-review":
    process.exit(await awaitReview(Number(rest[0]), rest[1], Number(rest[2] ?? 480), Number(rest[3] ?? 5)));
    break;
  case "resolve":
    resolve(rest[0]);
    break;
  default:
    process.stderr.write("usage: cr.mjs findings <pr> | await-review <pr> <sha> [maxWaitMin=480] [pollMin=5] | resolve <threadId>\n");
    process.exit(2);
}
