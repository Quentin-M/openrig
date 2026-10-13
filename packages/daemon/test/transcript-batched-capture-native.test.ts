// #161 against a real tmux server: 30 rotating sessions share batched captures, every transcript equals the session's
// own `capture-pane` byte for byte, a killed session leaves the others current (the listing drops it before the chain),
// and a ~0.9 MiB pane rides in the batch without splitting it.
import { describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { clearAllTranscriptRotationsForTest, startTranscriptRotation } from "../src/domain/transcript-rotation.js";

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

const exec = promisify(execFile);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!nativeAvailable)("native batched transcript capture (#161)", () => {
  it("30 sessions: byte-identical transcripts, bounded calls per round, a killed session isolated", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "batched-native-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMUX_TMPDIR: home };
    delete env.TMUX;
    const tmux = async (...args: string[]) => (await exec("tmux", ["-f", "/dev/null", ...args], { env, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
    const calls: Array<{ at: number; argv: string[] }> = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("expected argv transport"); }, undefined, async (argv, opts) => {
      calls.push({ at: Date.now(), argv });
      return (await exec(argv[0]!, argv.slice(1), { env, timeout: 10_000, ...(opts?.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}) })).stdout;
    });
    const names = Array.from({ length: 30 }, (_, i) => `seat-${i}@native`);
    const wide = names[7]!;
    const file = (n: string) => path.join(home, `${n}.log`);
    const capture = (n: string) => tmux("capture-pane", "-p", "-t", `=${n}:`, "-S", "-1000");
    /** Wait until every transcript equals its session's own capture (both read now, so a racing write retries). */
    const converged = async (sessions: string[], timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const pending: string[] = [];
        for (const n of sessions) {
          const expected = await capture(n);
          if (!fs.existsSync(file(n)) || fs.readFileSync(file(n), "utf8") !== expected) pending.push(n);
        }
        if (pending.length === 0 || Date.now() > deadline) return pending;
        await wait(200);
      }
    };
    try {
      for (const n of names) {
        const lines = n === wide
          ? "i=0; while [ $i -lt 1100 ]; do printf '%0899d\\n' $i; i=$((i+1)); done"
          : `i=0; while [ $i -lt 40 ]; do echo "${n} line $i"; i=$((i+1)); done`;
        await tmux("new-session", "-d", "-s", n, "-x", n === wide ? "900" : "120", "-y", "40", `${lines}; exec cat`);
      }
      await expect.poll(async () => (await capture(wide)).length, { timeout: 15_000 }).toBeGreaterThan(900_000);
      for (const n of names) startTranscriptRotation(adapter, n, file(n), { lines: 1000, pollIntervalMs: 2000 }, () => ({ lines: 1000, pollIntervalMs: 2000 }));
      expect(await converged(names, 15_000)).toEqual([]);
      expect(Buffer.byteLength(fs.readFileSync(file(wide), "utf8"))).toBeGreaterThan(900_000);

      // Busy rounds: every session prints, and a round's captures stay within list-sessions + ceil(30/24) chains.
      const roundsFrom = Date.now();
      for (let round = 0; round < 3; round++) {
        for (const n of names) await tmux("send-keys", "-t", `=${n}:`, "-l", `round ${round} ${n}\n`);
        await wait(2000);
      }
      expect(await converged(names, 10_000)).toEqual([]);
      // Per-session capture would fork 30 times per 2s cadence. Batched: a listing and a chain per chunk of 24 due
      // sessions, so at most 4 forks per 1s timer step when every session is due.
      const elapsedSteps = Math.ceil((Date.now() - roundsFrom) / 1000);
      const forks = calls.filter((c) => c.at >= roundsFrom && (c.argv[1] === "list-sessions" || c.argv.includes("capture-pane")));
      expect(forks.length).toBeLessThanOrEqual(4 * (elapsedSteps + 1));
      expect(forks.filter((c) => c.argv[1] === "display-message").length).toBeGreaterThanOrEqual(3);
      // One listing per chain; a round read mid-flight has listed its two chunks before chaining them.
      expect(forks.filter((c) => c.argv[1] === "list-sessions").length)
        .toBeLessThanOrEqual(forks.filter((c) => c.argv[1] === "display-message").length + 2);

      const killed = names[3]!;
      const before = fs.readFileSync(file(killed), "utf8");
      await tmux("kill-session", "-t", `=${killed}`);
      const alive = names.filter((n) => n !== killed);
      for (const n of alive) await tmux("send-keys", "-t", `=${n}:`, "-l", `after kill ${n}\n`);
      expect(await converged(alive, 10_000)).toEqual([]);
      for (const n of alive) expect(fs.readFileSync(file(n), "utf8")).toContain(`after kill ${n}`);
      expect(fs.readFileSync(file(killed), "utf8")).toBe(before);
    } finally {
      clearAllTranscriptRotationsForTest();
      await tmux("kill-server").catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
