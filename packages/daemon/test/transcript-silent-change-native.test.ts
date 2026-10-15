// Real tmux, one private server per case. An idle seat runs transcript rotation and the structural sweep through one
// TmuxAdapter, as the daemon wires them. Then one tmux operation that changes the pane's text without printing (a resize
// round trip, a terminal reset, a pane swap, ...) or a capture that fails. Each case checks how long the transcript and
// the structural verdict take to match a fresh capture, and that no reported capture time runs ahead of a real capture.
// TMUX_BIN picks the tmux binary (default "tmux").
import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { classifyPaneActivity } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";

delete process.env.TMUX; delete process.env.TMUX_PANE;
const TMUX = process.env.TMUX_BIN ?? "tmux";
let nativeAvailable = process.platform !== "win32";
try { execFileSync(TMUX, ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }
const OUT = process.env.SILENT_CHANGE_OUT; // one JSON line per measurement, when set
const WAIT_MS = 20_000;
// How fast a change must show. The verdict: by the end of the second structural sweep after the change, or after a
// capture starts failing. The transcript: by the next tick after the pane key moves; a failing capture by the next
// idle tick (6 s ceiling) and, for ingest, once the last capture is 10 s old.
const FULL_READ_MS = 0; // every sweep reads every seat
const POLL_SLACK_MS = 200; // the test reads the verdict every 100 ms
const BOUND = { transcriptMs: 8000, rotationFailureMs: 8000, ingestMs: 12_000 };
const exec = promisify(execFile);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const record = (row: object) => { if (OUT) appendFileSync(OUT, JSON.stringify({ tmux: TMUX, ...row }) + "\n"); };

const PROMPT = String.raw`printf 'Do you want to proceed?\n\342\235\257 1. Yes\n  2. No\n\n\n\n'`;
const LINES = (n: number) => `for i in $(seq 1 ${n}); do echo line-$i; done`;

interface Seat {
  name: string; run: (...a: string[]) => Promise<string>; file: string; store: TranscriptStore; svc: SeatStructuralActivityService;
  // end of the last real rotation (1000-line) and structural (20-line) capture
  lastEnd: { rotation: number; structural: number }; listings: { live: number; max: number }; failCaptures: { on: boolean };
  rotationCalls: { all: number; failed: number };
  // [start, end] of every structural sweep that ran (a tick that found one in flight is not a sweep)
  sweeps: Array<[number, number]>;
  done: () => Promise<void>;
}

async function seat(name: string, opts: { history: number; screen: string; listingDelayS?: number }): Promise<Seat> {
  const socket = `silent-${name.replace(/\W/g, "")}-${process.pid}`;
  const root = mkdtempSync(join(tmpdir(), `silent-${name.replace(/\W/g, "")}-`));
  writeFileSync(join(root, "tmux.conf"), `set -g history-limit ${opts.history}\n`);
  const base = ["-L", socket, "-f", join(root, "tmux.conf")];
  const run = async (...a: string[]) => (await exec(TMUX, [...base, ...a], { timeout: 15_000, maxBuffer: 16 << 20 })).stdout;
  const lastEnd = { rotation: 0, structural: 0 };
  const listings = { live: 0, max: 0 };
  const failCaptures = { on: false };
  const rotationCalls = { all: 0, failed: 0 };
  const adapter = new TmuxAdapter(async () => { throw new Error("argv only"); }, undefined, async (argv) => {
    const args = argv.slice(1);
    const capture = args.includes("capture-pane");
    if (capture && args.includes("-1000")) rotationCalls.all += 1;
    if (capture && failCaptures.on) { if (args.includes("-1000")) rotationCalls.failed += 1; throw new Error("injected capture failure"); }
    const listing = args[0] === "list-windows";
    if (listing) { listings.live += 1; listings.max = Math.max(listings.max, listings.live); }
    try {
      // The delay is a real child: the listing stays a live process for its whole duration.
      const out = listing && opts.listingDelayS
        ? (await exec("sh", ["-c", `sleep ${opts.listingDelayS}; exec "$0" "$@"`, TMUX, ...base, ...args], { timeout: 30_000 })).stdout
        : await run(...args).catch((err) => { if (capture && args.includes("-1000")) rotationCalls.failed += 1; throw err; });
      if (capture) lastEnd[args.includes("-1000") ? "rotation" : "structural"] = Date.now();
      return out;
    } finally { if (listing) listings.live -= 1; }
  });
  await run("new-session", "-d", "-s", name, "-x", "100", "-y", "20", "sh", "-c", `${opts.screen}; exec sleep 100000`);
  await wait(800);
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db), reg = new SessionRegistry(db);
  const node = rigRepo.addNode(rigRepo.createRig("r").id, `dev.${name}`, { runtime: "claude-code" });
  const sess = reg.registerSession(node.id, name);
  reg.updateStatus(sess.id, "running");
  reg.updateBinding(node.id, { tmuxSession: name, attachmentType: "tmux" });
  const store = new TranscriptStore({ transcriptsRoot: root });
  const file = store.getTranscriptPath("r", name);
  const svc = new SeatStructuralActivityService(adapter);
  const sweeps: Array<[number, number]> = [];
  const sweep = svc.pollAllRunningTmuxSeats.bind(svc);
  svc.pollAllRunningTmuxSeats = async (d) => {
    const busy = (svc as unknown as { sweeping: boolean }).sweeping, began = Date.now();
    await sweep(d);
    if (!busy) sweeps.push([began, Date.now()]);
  };
  const ropts = { lines: 1000, pollIntervalMs: 2000 };
  startTranscriptRotation(adapter, name, file, ropts, () => ropts);
  svc.start(db, 1000);
  return {
    name, run, file, store, svc, lastEnd, listings, failCaptures, rotationCalls, sweeps,
    done: async () => { svc.stop(); stopTranscriptRotation(name); await run("kill-server").catch(() => {}); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** When the second structural sweep that started at or after `from` ended, in ms after `t0`; null if none did. Two
 *  sweeps, so a sweep already reading when the change landed is not counted: the bound is in sweeps, not seconds, so
 *  a host slow enough to stretch a sweep cannot fail it while every sweep still reads what it should. */
function secondSweepEnd(s: Seat, t0: number, from: number): number | null {
  const after = s.sweeps.filter(([began]) => began >= from);
  return after.length >= 2 ? after[1]![1] - t0 : null;
}
/** secondSweepEnd once those sweeps have run, or null after `ms`. */
async function sweepBound(s: Seat, t0: number, from: number, ms = WAIT_MS): Promise<number | null> {
  const until = Date.now() + ms;
  while (secondSweepEnd(s, t0, from) === null && Date.now() < until) await wait(100);
  return secondSweepEnd(s, t0, from);
}

const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
/** What a capture now shows: the transcript should equal a fresh 1000-line read, the verdict a fresh 20-line read's. */
async function truth(s: Seat) {
  const full = await s.run("capture-pane", "-p", "-t", `=${s.name}:`, "-S", "-1000");
  const short = await s.run("capture-pane", "-p", "-t", `=${s.name}:`, "-S", "-20");
  return { full, verdict: short === "" ? null : classifyPaneActivity(short).state };
}

/** Polls every 100 ms after the operation until both match, or WAIT_MS. A reported capture time later than the last
 *  real capture (plus the write that follows it) counts as a capture time ahead of a real capture. */
async function measure(s: Seat, label: string, act: () => Promise<unknown>) {
  await wait(9000); // idle: ticks and sweeps after the first capture are skips
  const before = await truth(s);
  const actAt = Date.now();
  await act();
  // From when the change is complete: the operation's own tmux calls are not the daemon's latency.
  const t0 = Date.now();
  const after = await truth(s);
  let transcriptAt: number | null = null, verdictAt: number | null = null, dishonest = 0;
  while (Date.now() - t0 < WAIT_MS && (transcriptAt === null || verdictAt === null)) {
    const now = await truth(s);
    const h = s.store.getIngestHealth("r", s.name);
    const obs = s.svc.getStructuralActivity(s.name);
    if (transcriptAt === null && read(s.file) === now.full) transcriptAt = Date.now() - t0;
    if (verdictAt === null && (obs?.state ?? null) === now.verdict) verdictAt = Date.now() - t0;
    if (h.lastCapturedAt && Date.parse(h.lastCapturedAt) > s.lastEnd.rotation + 500) dishonest += 1;
    if (obs && Date.parse(obs.observedAt) > s.lastEnd.structural + 500) dishonest += 1;
    await wait(100);
  }
  const row = { case: label, textChanged: before.full !== after.full, verdictBefore: before.verdict, verdictAfter: after.verdict,
    transcriptMs: transcriptAt, verdictMs: verdictAt, dishonestStamps: dishonest, verdictBoundMs: await sweepBound(s, t0, t0), actMs: t0 - actAt };
  record(row);
  return row;
}

type Op = (s: Seat) => Promise<unknown>;
const roundTrip = (flag: "-x" | "-y", small: number, big: number): Op => async (s) => {
  await s.run("resize-window", "-t", `=${s.name}:`, flag, String(small)); await wait(300); await s.run("resize-window", "-t", `=${s.name}:`, flag, String(big));
};
// changes: the operation is known to change the capture on every tmux tested (3.3a, 3.4, 3.8)
const CASES: Array<{ label: string; history: number; screen: string; op: Op; changes?: boolean }> = [
  { label: "resize round trip 20 > 2 > 20 rows, no scrollback, a prompt on screen", history: 0, screen: PROMPT, op: roundTrip("-y", 2, 20), changes: true },
  { label: "send-keys -R (terminal reset), no scrollback, a prompt on screen", history: 0, screen: PROMPT, op: (s) => s.run("send-keys", "-R", "-t", `=${s.name}:`), changes: true },
  { label: "send-keys -R, with scrollback", history: 2000, screen: `${LINES(40)}; ${PROMPT}`, op: (s) => s.run("send-keys", "-R", "-t", `=${s.name}:`) },
  { label: "resize round trip, with scrollback, cursor at top", history: 2000, screen: `${LINES(15)}; printf '\\033[H'`, op: roundTrip("-y", 2, 20) },
  { label: "resize-pane round trip in a split window", history: 0, screen: PROMPT, op: async (s) => {
    await s.run("split-window", "-d", "-v", "-t", `=${s.name}:`, "sleep 100000"); await s.run("resize-pane", "-t", `=${s.name}:.0`, "-y", "2");
    await wait(300); await s.run("kill-pane", "-t", `=${s.name}:.1`);
  } },
  { label: "break-pane round trip", history: 0, screen: PROMPT, op: async (s) => {
    await s.run("split-window", "-d", "-t", `=${s.name}:`, "sleep 100000"); await s.run("break-pane", "-d", "-s", `=${s.name}:.1`);
    await wait(300); await s.run("kill-window", "-t", `=${s.name}:1`);
  } },
  { label: "swap-pane with a same-size pane", history: 2000, screen: PROMPT, op: async (s) => {
    await s.run("new-session", "-d", "-s", `${s.name}-o`, "-x", "100", "-y", "20", "sh", "-c", "echo other; exec sleep 100000"); await wait(400);
    await s.run("swap-pane", "-s", `=${s.name}-o:0.0`, "-t", `=${s.name}:0.0`);
  } },
  { label: "copy-mode enter and exit (text unchanged)", history: 2000, screen: `${LINES(40)}; ${PROMPT}`, op: async (s) => {
    await s.run("copy-mode", "-t", `=${s.name}:`); await s.run("send-keys", "-t", `=${s.name}:`, "-X", "history-top"); await s.run("send-keys", "-t", `=${s.name}:`, "-X", "cancel");
  } },
  { label: "display-panes and select-layout (text unchanged)", history: 2000, screen: PROMPT, op: async (s) => {
    await s.run("display-panes", "-t", `=${s.name}:`, "-d", "200").catch(() => {}); await s.run("select-layout", "-t", `=${s.name}:`, "tiled");
  } },
];

const seats: Seat[] = [];
afterAll(async () => { for (const s of seats) await s.done(); });

describe.concurrent.skipIf(!nativeAvailable)("silent text changes on an idle seat", () => {
  CASES.forEach((c, i) => {
    it(c.label, async () => {
      const s = await seat(`c${i}-s@r`, { history: c.history, screen: c.screen });
      seats.push(s);
      const r = await measure(s, c.label, () => c.op(s));
      if (c.changes) expect(r.textChanged).toBe(true);
      expect(r.transcriptMs, "transcript").not.toBeNull();
      expect(r.transcriptMs!, "transcript").toBeLessThanOrEqual(BOUND.transcriptMs);
      expect(r.verdictMs, "verdict").not.toBeNull();
      expect(r.verdictBoundMs, "two structural sweeps ran after the change").not.toBeNull();
      expect(r.verdictMs!, "verdict by the end of the second sweep after the change").toBeLessThanOrEqual(r.verdictBoundMs! + POLL_SLACK_MS);
      expect(r.dishonestStamps, "capture times ahead of the last real capture").toBe(0);
    }, WAIT_MS + 40_000);
  });

  const FAILURES: Array<[string, (s: Seat) => Promise<unknown>]> = [
    // capture-pane alone fails while list-windows still lists the seat
    ["injected capture-pane failure", async (s) => { s.failCaptures.on = true; }],
    ["session killed", (s) => s.run("kill-session", "-t", `=${s.name}`)],
    ["tmux server killed", (s) => s.run("kill-server")],
  ];
  for (const [how, act] of FAILURES) it(`a failing capture on an idle seat is noticed: ${how}`, async () => {
    const s = await seat(`fail${how.length}-s@r`, { history: 2000, screen: PROMPT });
    seats.push(s);
    await wait(9000);
    const lastStructuralBefore = s.lastEnd.structural;
    const t0 = Date.now();
    await act(s);
    let verdictDroppedMs: number | null = null, rotationFailedMs: number | null = null, ingestDegradedMs: number | null = null;
    while (Date.now() - t0 < WAIT_MS && (verdictDroppedMs === null || rotationFailedMs === null || ingestDegradedMs === null)) {
      if (verdictDroppedMs === null && s.svc.getStructuralActivity(s.name) === null) verdictDroppedMs = Date.now() - t0;
      if (rotationFailedMs === null && s.rotationCalls.failed > 0) rotationFailedMs = Date.now() - t0;
      if (ingestDegradedMs === null && s.store.getIngestHealth("r", s.name).state !== "live") ingestDegradedMs = Date.now() - t0;
      await wait(100);
    }
    // A full read is due FULL_READ_MS after the seat's last real structural capture before the failure.
    const verdictBoundMs = await sweepBound(s, t0, Math.max(t0, lastStructuralBefore + FULL_READ_MS));
    record({ case: `failing capture on an idle seat: ${how}`, verdictDroppedMs, rotationFailedMs, ingestDegradedMs, verdictBoundMs });
    expect(verdictDroppedMs).not.toBeNull();
    expect(verdictBoundMs, "two structural sweeps ran once a full read was due").not.toBeNull();
    expect(verdictDroppedMs!, "verdict dropped by the end of the second sweep once a full read was due").toBeLessThanOrEqual(verdictBoundMs! + POLL_SLACK_MS);
    expect(rotationFailedMs).not.toBeNull(); expect(rotationFailedMs!).toBeLessThanOrEqual(BOUND.rotationFailureMs);
    expect(ingestDegradedMs).not.toBeNull(); expect(ingestDegradedMs!).toBeLessThanOrEqual(BOUND.ingestMs);
  }, WAIT_MS + 40_000);

  it("list-windows delayed 8 s: one listing alive at a time, captures carry on", async () => {
    const s = await seat("slow-s@r", { history: 2000, screen: PROMPT, listingDelayS: 8 });
    seats.push(s);
    let verdictMissing = 0, polls = 0;
    const t0 = Date.now();
    await wait(3000);
    while (Date.now() - t0 < 24_000) {
      polls += 1;
      if (s.svc.getStructuralActivity(s.name) === null) verdictMissing += 1;
      await wait(250);
    }
    const row = { case: "list-windows delayed 8 s", maxLiveListings: s.listings.max, verdictMissingPolls: verdictMissing, polls,
      rotationCaptures: s.rotationCalls.all };
    record(row);
    expect(row.maxLiveListings).toBeLessThanOrEqual(1);
    expect(row.verdictMissingPolls).toBe(0);
    expect(row.rotationCaptures).toBeGreaterThanOrEqual(8);
  }, 60_000);
});
