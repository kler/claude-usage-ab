#!/usr/bin/env node
// Measures how fast Claude Code's 5-hour plan window drains per token, by client entrypoint.
// Context: https://github.com/anthropics/claude-code/issues/97074. Usage: see README.md.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Leaves the label unset so the Agent SDK applies its default, as apps built on the SDK do.
const ARM_SDK_DEFAULT = "sdk-ts";
// Runs `claude -p` with no label, as the issue's reporters did; the CLI then labels itself.
const ARM_PRINT_MODE = "sdk-cli";

// The VS Code extension (2.1.301) sets these on every Claude process besides its label. Every arm
// gets them, so the arms differ only in how the entrypoint label comes about.
const VSCODE_COMMON_ENV = {
  MCP_CONNECTION_NONBLOCKING: "true",
  CLAUDE_CODE_ENABLE_TASKS: "0",
  CLAUDE_CODE_EMIT_STARTUP_TIMING: "1",
};

// Inherited from a parent Claude Code or SDK app session, these would relabel the child process.
const INHERITED_ENV_TO_DROP = [
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SDK_READS_SESSION_STATE",
  "TRACEPARENT",
  "TRACESTATE",
];

const COLORS = ["amber", "azure", "coral", "ivory", "jade", "lilac", "olive", "pearl", "rust", "slate", "teal", "umber"];
const WORDS = ["ledger", "entry", "checked", "pending", "filed", "audit", "copy", "draft", "batch", "sealed", "noted", "stamped"];

const REPO_URL = "https://github.com/kler/claude-usage-ab";
const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
// Inside the repo, so results can be committed and the generated issue comment can link to them.
const RESULTS_DIR = path.join(REPO_DIR, "results");
const REPORTS_DIR = path.join(REPO_DIR, "reports");
// `run --test` output checks the harness, not usage, so it goes to a gitignored folder.
const TEST_RESULTS_DIR = path.join(REPO_DIR, "test-results");

class Abort extends Error {}

/** ISO 8601 UTC to the second, with ":" as "-" so it is a valid file name on every OS. */
const fileStamp = (date = new Date()) => date.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");

/** Path of a run's files without extension: `<dir>/<ISO time>-<kind>`, or `--out` with any extension dropped. */
function resultsBase(out, kind, dir = RESULTS_DIR) {
  return out ? path.resolve(out).replace(/\.(jsonl|md)$/, "") : path.join(dir, `${fileStamp()}-${kind}`);
}

/** Never overwrites: a name already taken (same second) gets a numeric suffix. */
function freshPath(dir, base, ext) {
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${base}${n === 1 ? "" : `-${n}`}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const subtractTokens = (a, b) => ({
  input: a.input - b.input,
  output: a.output - b.output,
  cacheRead: a.cacheRead - b.cacheRead,
  cacheWrite: a.cacheWrite - b.cacheWrite,
});

/** Input-token equivalents at Anthropic's price ratios: cache write 1.25x, cache read 0.1x, output 5x. */
function weigh(u) {
  return u.input + 1.25 * u.cacheWrite + 0.1 * u.cacheRead + 5 * u.output;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w) => String(n).padStart(w, "0");
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/** Writes a deterministic corpus and the prompt list. Every arm and every client gets identical prompts. */
function prepareWorkspace(dir, { files, lines, maxTurns }) {
  const corpus = path.join(dir, "corpus");
  fs.mkdirSync(corpus, { recursive: true });
  const rand = mulberry32(42);
  for (let f = 1; f <= files; f++) {
    const rows = [];
    for (let l = 1; l <= lines; l++) {
      rows.push(
        `R${pad(f, 2)}-${pad(l, 4)} ${pick(rand, COLORS)} ${pad(Math.floor(rand() * 1e6), 6)} ${pick(rand, WORDS)} ${pick(rand, WORDS)}`,
      );
    }
    fs.writeFileSync(path.join(corpus, `part-${pad(f, 2)}.txt`), rows.join("\n") + "\n");
  }
  const qrand = mulberry32(7);
  const questions = [];
  for (let i = 0; i < maxTurns; i++) {
    const line = `R${pad(1 + Math.floor(qrand() * files), 2)}-${pad(1 + Math.floor(qrand() * lines), 4)}`;
    questions.push(
      `Answer from the files you already read, without using tools. What color is on line ${line}? Reply with the color word only.`,
    );
  }
  return { files, questions };
}

function firstPrompt(tag, files) {
  // The tag makes every session's conversation prefix unique, so no block reuses another's prompt cache.
  return [
    `Run tag: ${tag}`,
    `Use the Read tool to read every file in ./corpus (part-01.txt to part-${pad(files, 2)}.txt), all in parallel.`,
    "Then reply with exactly one word: read",
  ].join("\n");
}

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const key of INHERITED_ENV_TO_DROP) delete env[key];
  // claude.ai connectors would add MCP traffic that differs between machines and clients.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return { ...env, ...extra };
}

function resolveClaude(given) {
  if (given) return path.resolve(given);
  return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Results are committed, so paths drop the home directory, which names whoever ran the test. */
const anonymizePath = (p) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

function environmentInfo(claude) {
  const sdkPackage = path.join(REPO_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json");
  return {
    claudeBinary: anonymizePath(claude),
    claudeVersion: claude ? execFileSync(claude, ["--version"], { encoding: "utf8" }).trim() : null,
    agentSdkVersion: fs.existsSync(sdkPackage) ? JSON.parse(fs.readFileSync(sdkPackage, "utf8")).version : null,
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
  };
}

// Recorded in every run: results from different meter methods are not comparable.
const METER_METHOD = "per-request utilization from rate_limit_event";

/**
 * The 5-hour and weekly utilization in a turn's rate-limit events. The CLI reports them from the
 * response of each request, as soon as they change, so ticks show up at the request that caused
 * them, unlike the usage lookup, which refreshes about once a minute.
 */
function eventReading(limits) {
  let reading;
  for (const info of limits ?? []) {
    const windows = info.unifiedWindows;
    if (windows?.five_hour?.utilization == null) continue;
    reading = {
      fiveHour: Math.round(windows.five_hour.utilization * 100),
      fiveHourResetsAt: windows.five_hour.resetsAt ? new Date(windows.five_hour.resetsAt * 1000).toISOString() : null,
      sevenDay: windows.seven_day?.utilization == null ? null : Math.round(windows.seven_day.utilization * 100),
    };
  }
  return reading;
}

/**
 * Which harness code produced a run. Results come from working copies too, so besides the version and
 * commit this records whether the harness files had local changes, and a hash of the script that ran.
 */
function harnessInfo() {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git("rev-parse", "HEAD");
  const changed = commit ? git("status", "--porcelain", "--", "ab.mjs", "package.json", "package-lock.json") : null;
  return {
    version: JSON.parse(fs.readFileSync(path.join(REPO_DIR, "package.json"), "utf8")).version,
    commit,
    modified: commit ? Boolean(changed) : null,
    scriptSha256: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
  };
}

/** The command as typed, with home-directory paths shortened, so a report shows exactly how it was run. */
const commandLine = () => ["node", "ab.mjs", ...process.argv.slice(2).map((a) => anonymizePath(a))].join(" ");

/** Streaming-input queue: the session stays open across turns, like SDK apps and the VS Code extension. */
function makeInput() {
  const queue = [];
  let wake = null;
  let ended = false;
  async function* iterate() {
    for (;;) {
      while (queue.length > 0) yield queue.shift();
      if (ended) return;
      await new Promise((resolve) => (wake = resolve));
      wake = null;
    }
  }
  return {
    iterable: iterate(),
    push(text) {
      queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

const ISOLATION_OPTIONS = {
  // No user or project settings: no hooks, CLAUDE.md, plugins or MCP servers from this machine.
  settingSources: [],
  settings: { disableAllHooks: true },
  mcpServers: {},
  strictMcpConfig: true,
};

/**
 * Starts the exact process the SDK would, plus `-p` and minus the label, so the CLI picks its own
 * entrypoint for print mode. Assumes a native `claude` binary, whose first argument is a flag.
 */
function spawnPrintMode({ command, args, cwd, env, signal }, onStderr) {
  const childEnv = { ...env };
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  const child = spawn(command, ["-p", ...args], { cwd, env: childEnv, signal, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => onStderr(chunk.toString()));
  return child;
}

function openSession({ cwd, model, effort, claude, arm, stderrPath }) {
  const input = makeInput();
  const env = cleanEnv(VSCODE_COMMON_ENV);
  if (arm !== ARM_SDK_DEFAULT && arm !== ARM_PRINT_MODE) env.CLAUDE_CODE_ENTRYPOINT = arm;
  const onStderr = (chunk) => fs.appendFileSync(stderrPath, chunk);
  const q = query({
    prompt: input.iterable,
    options: {
      ...ISOLATION_OPTIONS,
      cwd,
      model,
      ...(effort ? { effort } : {}),
      pathToClaudeCodeExecutable: claude,
      env,
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: ["Read"],
      allowedTools: ["Read"],
      permissionMode: "dontAsk",
      stderr: onStderr,
      ...(arm === ARM_PRINT_MODE ? { spawnClaudeCodeProcess: (o) => spawnPrintMode(o, onStderr) } : {}),
    },
  });
  return {
    q,
    input,
    messages: q[Symbol.asyncIterator](),
    close() {
      input.end();
      q.close();
    },
  };
}

/** A session that never sends a prompt, only to read the plan meter. Costs no tokens. */
async function openProbe(claude) {
  const input = makeInput();
  const q = query({
    prompt: input.iterable,
    options: {
      ...ISOLATION_OPTIONS,
      cwd: os.tmpdir(),
      pathToClaudeCodeExecutable: claude,
      env: cleanEnv({}),
      persistSession: false,
      tools: [],
      stderr: () => {},
    },
  });
  const init = await q.initializationResult();
  return { q, account: init.account ?? {}, close: () => (input.end(), q.close()) };
}

/**
 * Reads the plan meter. A CLI process caches its usage lookup for about a minute, so a long-lived
 * session sees the meter jump once a minute; a fresh session per reading sees it as it moves.
 */
async function openMeter(claude) {
  const probe = await openProbe(claude);
  return {
    account: probe.account,
    async read() {
      const fresh = await openProbe(claude);
      try {
        return await readUsage(fresh.q);
      } finally {
        fresh.close();
      }
    },
    close: probe.close,
  };
}

/** Who the CLI is logged in as. Shown before spending, never written to results, which get committed. */
function describeAccount(account) {
  const who = [account.email, account.organization].filter(Boolean).join(", ") || "unknown account";
  return `${who} (config: ${anonymizePath(claudeHome())})`;
}

function describeReset(iso) {
  if (!iso) return "";
  const at = new Date(iso);
  const minutes = Math.max(0, Math.round((at.getTime() - Date.now()) / 60_000));
  const left = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `, resets ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (in ${left})`;
}

/** Starts every arm's process without sending a prompt, so a broken arm fails before anything is spent. */
async function preflight({ arms, claude, opts, cwd, stderrPath }) {
  for (const arm of arms) {
    const session = openSession({ cwd, model: opts.model, effort: opts.effort, claude, arm, stderrPath });
    try {
      await session.q.initializationResult();
    } catch (error) {
      throw new Abort(`Arm ${arm} failed to start, so nothing was spent: ${error?.message ?? error}`);
    } finally {
      session.close();
    }
  }
}

async function confirmSpend(lines, opts) {
  const warning = [
    "",
    "WARNING: this sends real prompts to Claude and spends real plan usage on this account.",
    ...lines.map((l) => `  ${l}`),
    "  Stop every other Claude use on this account (all devices) until the run ends.",
    "",
  ].join("\n");
  console.log(warning);
  if (opts.yes) return;
  if (!process.stdin.isTTY) throw new Abort("Not a terminal, so cannot ask for confirmation. Pass --yes to accept the spend.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Type "yes" to continue: ');
    if (answer.trim().toLowerCase() !== "yes") throw new Abort("Cancelled. Nothing was spent.");
  } finally {
    rl.close();
  }
}

async function readUsage(q) {
  const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  const fiveHour = usage.rate_limits?.five_hour;
  if (!usage.rate_limits_available || fiveHour?.utilization == null) {
    throw new Abort(
      "Plan usage is unavailable. This needs a claude.ai subscription login; unset ANTHROPIC_API_KEY if it is set.",
    );
  }
  return {
    fiveHour: fiveHour.utilization,
    fiveHourResetsAt: fiveHour.resets_at,
    sevenDay: usage.rate_limits.seven_day?.utilization ?? null,
    sevenDayResetsAt: usage.rate_limits.seven_day?.resets_at ?? null,
    subscription: usage.subscription_type,
  };
}

function sameWindow(a, b) {
  if (!a || !b) return true;
  return Math.abs(Date.parse(a) - Date.parse(b)) < 120_000;
}

async function runTurn(session, text) {
  session.input.push(text);
  const limits = [];
  for (;;) {
    const { value: message, done } = await session.messages.next();
    if (done) throw new Error("Claude exited in the middle of a turn. See stderr.log.");
    if (message.type === "rate_limit_event") limits.push(message.rate_limit_info);
    if (message.type === "result") return { result: message, limits };
  }
}

function guardOverage(limits) {
  for (const info of limits) {
    if (info.isUsingOverage || info.overageInUse || info.status === "rejected") {
      throw new Abort(`Stopped: Claude reported ${JSON.stringify(info)}. The test must not spend overage or hit the limit.`);
    }
  }
}

function sumModelUsage(modelUsage) {
  const total = emptyTokens();
  for (const u of Object.values(modelUsage ?? {})) {
    total.input += u.inputTokens;
    total.output += u.outputTokens;
    total.cacheRead += u.cacheReadInputTokens;
    total.cacheWrite += u.cacheCreationInputTokens;
  }
  return total;
}

function listJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
}

/** Token totals and entrypoint labels from Claude Code transcripts, de-duplicated per API message. */
function transcriptUsage(files) {
  const byMessage = new Map();
  const entrypoints = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.entrypoint) entrypoints.add(entry.entrypoint);
      const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
      if (usage) byMessage.set(`${entry.requestId ?? ""}:${entry.message.id ?? entry.uuid}`, usage);
    }
  }
  const total = emptyTokens();
  for (const u of byMessage.values()) {
    total.input += u.input_tokens ?? 0;
    total.output += u.output_tokens ?? 0;
    total.cacheRead += u.cache_read_input_tokens ?? 0;
    total.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  return { total, entrypoints: [...entrypoints] };
}

function findTranscript(sessionId) {
  const projects = path.join(claudeHome(), "projects");
  if (!fs.existsSync(projects)) return undefined;
  for (const dir of fs.readdirSync(projects)) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const fmtTokens = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}k`);

/** A run is one `.jsonl` data file and one `.md` report of the same name. Meta rows are appended; later ones win. */
class Log {
  constructor(base) {
    this.file = `${base}.jsonl`;
    this.report = `${base}.md`;
    // Appending to an earlier run would mix two runs' data into one report.
    if (fs.existsSync(this.file)) throw new Abort(`${this.file} already holds a run. Choose a new --out.`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
  }
  write(row) {
    fs.appendFileSync(this.file, JSON.stringify(row) + "\n");
  }
  meta(value) {
    this.write({ kind: "meta", meta: value });
  }
}

/**
 * Runs one arm in a fresh session until the meter reaches `target`. Blocks are chained: each starts
 * right after the previous block's meter tick, so the tokens it spends bought exactly the points it
 * moved, give or take one turn at each end, and no usage is spent waiting for a first tick.
 */
async function runBlock({ log, block, arm, target, ctx }) {
  const { opts, meter, start, workspace, prompts, claude, stopped, stderrPath, progress } = ctx;
  const session = openSession({ cwd: workspace, model: opts.model, effort: opts.effort, claude, arm, stderrPath });
  const startedAt = Date.now();
  try {
    await session.q.initializationResult();
    const tag = randomUUID();
    let sessionId;
    let tokens = emptyTokens();
    let costUsd = 0;
    let turn = 0;
    while (turn < opts.maxTurns) {
      turn++;
      const text = turn === 1 ? firstPrompt(tag, prompts.files) : prompts.questions[turn - 2];
      const { result, limits } = await runTurn(session, text);
      guardOverage(limits);
      if (result.is_error) throw new Error(`Turn ${turn} failed: ${result.subtype} ${JSON.stringify(result.errors ?? [])}`);
      sessionId = result.session_id;
      tokens = sumModelUsage(result.modelUsage);
      costUsd = result.total_cost_usd;
      // Events only arrive when the value changes, so the last one still holds between them.
      // Without any events (an older CLI), fall back to the minute-refreshed usage lookup.
      const fromEvents = eventReading(limits);
      if (fromEvents) ctx.reading = { ...fromEvents, source: "event" };
      else if (ctx.reading?.source !== "event") ctx.reading = { ...(await meter.read()), source: "lookup" };
      const now = ctx.reading;
      if (!sameWindow(start.fiveHourResetsAt, now.fiveHourResetsAt)) {
        throw new Abort("The 5-hour window reset during the run. Start a new run early in a fresh window.");
      }
      const weighted = weigh(tokens);
      log.write({ kind: "sample", block, arm, turn, tokens, weighted, costUsd, fiveHour: now.fiveHour, sevenDay: now.sevenDay, meterSource: now.source, limits, at: new Date().toISOString() });
      progress.turn({ block, arm, turn, fiveHour: now.fiveHour, target, elapsed: Date.now() - startedAt });
      if (now.fiveHour >= target || now.fiveHour >= opts.maxUtil) break;
      if (now.sevenDay != null && now.sevenDay >= opts.maxWeekly) break;
      if (stopped()) break;
    }
    const transcript = sessionId ? findTranscript(sessionId) : undefined;
    // The transcript is a second client-side count. Model calls the CLI makes but never writes to it
    // (compaction, for one) show up as a gap between the two.
    const fromTranscript = transcript ? transcriptUsage([transcript]) : undefined;
    return {
      fiveHour: ctx.reading.fiveHour,
      sevenDay: ctx.reading.sevenDay,
      tokens,
      transcriptTokens: fromTranscript?.total ?? null,
      costUsd,
      turns: turn,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      labels: fromTranscript?.entrypoints ?? [],
      reached: ctx.reading.fiveHour >= target,
    };
  } finally {
    session.close();
  }
}

const T_975 = [NaN, 12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13];
const tCrit = (df) => (df < T_975.length ? T_975[df] : df < 30 ? 2.06 : 1.96);

function stats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, sd: NaN, se: NaN, half: NaN };
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, se, half: tCrit(n - 1) * se };
}

/**
 * Blocks rebuilt from the logged rate-limit events, for runs before 0.3.0 that ended blocks on the
 * minute-refreshed lookup. That lookup credits up to a minute of one arm's usage to the next block;
 * the events place every tick at the request that caused it. Each block runs from the meter value
 * where the previous block ended to its own last value; its tokens are the session's totals.
 */
function spansFromEvents(rows, loggedSpans) {
  const samples = rows.filter((r) => r.kind === "sample");
  if (!samples.some((s) => eventReading(s.limits))) return undefined;
  const ends = new Map();
  let current;
  let block;
  let startValue;
  for (const s of samples) {
    if (s.block !== block) {
      if (block !== undefined) ends.set(block, { start: startValue, end: current });
      block = s.block;
      startValue = current;
    }
    current = eventReading(s.limits)?.fiveHour ?? current;
  }
  if (block !== undefined) ends.set(block, { start: startValue, end: current });
  return loggedSpans
    .map((span) => {
      const range = ends.get(span.block);
      if (range?.start == null || range.end == null) return undefined;
      return { ...span, points: range.end - range.start, recomputed: true };
    })
    .filter((span) => span && span.points > 0);
}

function loadResults(files) {
  return files.map((file) => {
    if (!fs.existsSync(file)) throw new Abort(`No such results file: ${file}`);
    const run = path.basename(file, ".jsonl");
    const meta = {};
    const spans = [];
    const tests = [];
    const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    for (const row of rows) {
      if (row.kind === "meta") Object.assign(meta, row.meta);
      if (row.kind === "span") spans.push({ ...row, run });
      if (row.kind === "test") tests.push(row);
    }
    if (meta.meter !== METER_METHOD) {
      const recomputed = spansFromEvents(rows, spans);
      if (recomputed) return { file, run, meta, spans: recomputed, tests, meterUsed: `${METER_METHOD} (recomputed from the run's logged events)` };
    }
    return { file, run, meta, spans: spans.filter((s) => s.points > 0), tests, meterUsed: meta.meter };
  });
}

function analyze(runs) {
  const byArm = new Map();
  for (const span of runs.flatMap((r) => r.spans)) {
    const arm = byArm.get(span.arm) ?? { spans: [], labels: new Set(), sources: new Set() };
    arm.spans.push(span);
    for (const label of span.labels ?? []) arm.labels.add(label);
    arm.sources.add(span.source ?? "scripted");
    byArm.set(span.arm, arm);
  }
  const arms = [...byArm].map(([name, a]) => {
    const tokensPerPoint = stats(a.spans.map((s) => weigh(s.tokens) / s.points));
    const costPerPoint = a.spans.every((s) => s.costUsd != null) ? stats(a.spans.map((s) => s.costUsd / s.points)) : undefined;
    const points = a.spans.reduce((sum, s) => sum + s.points, 0);
    const mix = emptyTokens();
    for (const s of a.spans) for (const k of Object.keys(mix)) mix[k] += s.tokens[k];
    const checked = a.spans.filter((s) => s.transcriptTokens);
    const sdk = checked.reduce((sum, s) => sum + weigh(s.tokens), 0);
    const transcriptGap = checked.length ? (sdk - checked.reduce((sum, s) => sum + weigh(s.transcriptTokens), 0)) / sdk : undefined;
    return { name, labels: [...a.labels], sources: [...a.sources], spans: a.spans, tokensPerPoint, costPerPoint, points, mix, transcriptGap };
  });
  if (arms.length === 0) return { arms, ref: undefined };
  // The reference is the arm whose window drains slowest, so every other ratio reads as "x times faster".
  const ref = arms.reduce((best, r) => (r.tokensPerPoint.mean > best.tokensPerPoint.mean ? r : best));
  for (const arm of arms) {
    if (arm === ref) continue;
    const value = ref.tokensPerPoint.mean / arm.tokensPerPoint.mean;
    const relSe = Math.sqrt((ref.tokensPerPoint.se / ref.tokensPerPoint.mean) ** 2 + (arm.tokensPerPoint.se / arm.tokensPerPoint.mean) ** 2);
    const t = tCrit(Math.min(ref.tokensPerPoint.n, arm.tokensPerPoint.n) - 1);
    // On a log scale, so the interval stays positive and is as wide upward as downward in relative terms.
    arm.ratio = { value, low: value * Math.exp(-t * relSe), high: value * Math.exp(t * relSe) };
  }
  return { arms, ref };
}

/** A run setting, read from `settings` or, for runs recorded before 0.2.0, from the old top-level fields. */
const setting = (m, key) => m.settings?.[key] ?? m[key] ?? m.corpus?.[key];

/** "0.2.0 @ abc1234", flagged when the harness had local changes; old runs predate versioning. */
function describeHarness(h, { link = false, plain = false } = {}) {
  if (!h) return "unknown (recorded before 0.2.0)";
  const short = h.commit ? h.commit.slice(0, 7) : "no git";
  const commit = link && h.commit && !h.modified ? `[${short}](${REPO_URL}/commit/${h.commit})` : short;
  const changes = h.modified ? `, ${plain ? "with local changes" : "**with local changes**"} (script sha256 ${h.scriptSha256.slice(0, 12)})` : "";
  return `${h.version} @ ${commit}${changes}`;
}

const withCi = (s, fmt) => (Number.isNaN(s.half) ? fmt(s.mean) : `${fmt(s.mean)} ± ${fmt(s.half)}`);
const fmtRatio = (r) => (r ? (Number.isNaN(r.low) ? `${r.value.toFixed(2)}×` : `${r.value.toFixed(2)}× (${r.low.toFixed(2)}–${r.high.toFixed(2)})`) : "reference");

function armTable({ arms, ref }) {
  if (arms.length === 0) return "No complete measurements yet.";
  const lines = [
    `| Arm | Label in transcripts | Blocks | Points | Weighted tokens per point (95% CI) | List-price $ per point | Drains faster than ${ref.name} by (95% CI) |`,
    "|---|---|---|---|---|---|---|",
  ];
  for (const a of arms) {
    lines.push(
      `| ${a.name} | ${a.labels.join(", ") || "?"} | ${a.tokensPerPoint.n} | ${a.points} | ${withCi(a.tokensPerPoint, fmtTokens)} | ${a.costPerPoint ? withCi(a.costPerPoint, (v) => v.toFixed(2)) : "–"} | ${fmtRatio(a.ratio)} |`,
    );
  }
  return lines.join("\n");
}

const ARM_METHOD = {
  [ARM_SDK_DEFAULT]: "Agent SDK `query()` with `CLAUDE_CODE_ENTRYPOINT` unset; the SDK sets its default, as SDK apps such as T3 Code do.",
  [ARM_PRINT_MODE]: "The same SDK launch with `-p` added and `CLAUDE_CODE_ENTRYPOINT` removed, so the CLI labels itself, as with `claude -p --input-format stream-json`.",
};
const armMethod = (arm, sources) =>
  sources.includes("watch")
    ? "A real client, driven by hand with the same prompts; tokens read from its transcripts."
    : (ARM_METHOD[arm] ?? `The same SDK launch with \`CLAUDE_CODE_ENTRYPOINT=${arm}\` set by this harness, emulating that client's label.`);

const ARM_SHORT = {
  [ARM_SDK_DEFAULT]: "Agent SDK, label left to the SDK",
  [ARM_PRINT_MODE]: "`claude -p`, label chosen by the CLI",
};
const armShort = (arm, sources) =>
  sources.includes("watch") ? "Real client, driven by hand" : (ARM_SHORT[arm] ?? "Agent SDK, label set by the harness");

const armName = (a) => {
  const labels = a.labels.join(", ");
  return !labels || labels === a.name ? `\`${a.name}\`` : `\`${a.name}\` (\`${labels}\`)`;
};

const RAW_MAIN_URL = "https://raw.githubusercontent.com/kler/claude-usage-ab/main";

/** A run's report path inside this repository, or undefined when the run lives elsewhere. */
function reportPath(run) {
  const rel = path.relative(REPO_DIR, run.file.replace(/\.jsonl$/, ".md"));
  return rel.startsWith("..") || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join("/");
}

/** Links to the runs' reports, only for reports that are already on `main` on GitHub. */
async function publishedLinks(runs) {
  const links = new Map();
  for (const run of runs) {
    const rel = reportPath(run);
    if (!rel) continue;
    try {
      const response = await fetch(`${RAW_MAIN_URL}/${rel}`, { method: "HEAD" });
      if (response.ok) links.set(run.run, `${REPO_URL}/blob/main/${rel}`);
    } catch {
      // Offline or GitHub unreachable: leave the run unlinked.
    }
  }
  return links;
}

const runRef = (run, links) => (links.has(run.run) ? `[${run.run}](${links.get(run.run)})` : `\`${run.run}\` (not merged yet)`);

// Reports are written before their pull request exists, so their comment has no link yet.
const COMMENT_NOTE = (runs) =>
  `Ready to paste into the issue once this report is merged into ${REPO_URL}. Then \`node ab.mjs comment ${runs
    .map((r) => (reportPath(r) ?? r.file).replace(/\.md$/, ".jsonl"))
    .join(" ")}\` prints this comment with a link to the merged report.`;

const ARM_DESCRIPTION = {
  "sdk-ts": "Agent SDK apps",
  "sdk-cli": "`claude -p`",
  "claude-vscode": "the VS Code extension",
  cli: "the interactive CLI",
  "claude-desktop": "Claude Desktop",
};
const armPhrase = (a) => {
  const description = ARM_DESCRIPTION[a.name] ?? ARM_DESCRIPTION[a.labels[0]];
  return description ? `\`${a.name}\` (${description})` : `\`${a.name}\``;
};
const joinNames = (list) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
const fmtX = (v) => `${v.toFixed(1)}×`;

/**
 * The results in plain words: a headline and supporting sentences. An arm counts as different only
 * when its whole 95% interval is above 1; otherwise the sentence says the data cannot tell yet.
 */
function conclusion({ arms, ref }) {
  if (!ref || arms.length < 2) return { headline: "Not enough data: at least two arms need measured blocks.", details: [] };
  if (arms.some((a) => a.tokensPerPoint.n < 2)) {
    return { headline: "Not enough data yet: every arm needs at least two blocks before the arms can be compared.", details: [] };
  }
  const others = arms.filter((a) => a.ratio);
  const faster = others.filter((a) => a.ratio.low > 1);
  const same = others.filter((a) => !faster.includes(a) && a.ratio.high <= 1.15);
  const unclear = others.filter((a) => !faster.includes(a) && !same.includes(a));
  const ratioText = (list) => {
    const values = list.map((a) => a.ratio.value);
    const mean = values.reduce((x, y) => x + y, 0) / values.length;
    return Math.max(...values) / Math.min(...values) <= 1.1
      ? `about ${fmtX(mean)}`
      : joinNames(list.map((a) => `${fmtX(a.ratio.value)} (${a.name})`));
  };
  const sentences = [];
  if (faster.length) {
    const mean = faster.reduce((x, a) => x + a.ratio.value, 0) / faster.length;
    sentences.push(
      `${joinNames(faster.map(armPhrase))} used up the 5-hour limit ${ratioText(faster)} as fast as ${armPhrase(ref)} for the same work. Put the other way: the same allowance lasts only about ${Math.round(100 / mean)}% as long through ${faster.length > 1 ? "them" : "it"}.`,
    );
  }
  if (unclear.length) {
    sentences.push(
      `${joinNames(unclear.map(armPhrase))} ${unclear.length > 1 ? "appear" : "appears"} to use up the limit ${ratioText(unclear)} as fast as ${armPhrase(ref)}, but the measurement is not precise enough to be sure: the 95% interval still includes no difference.`,
    );
  }
  if (same.length) {
    sentences.push(`${joinNames(same.map(armPhrase))} and ${armPhrase(ref)} used up the limit at the same rate, within the measurement's precision.`);
  }
  const details = sentences.slice(1);
  if (unclear.length) {
    const spread = (a) => a.tokensPerPoint.half / a.tokensPerPoint.mean;
    const noisiest = arms.reduce((x, y) => (spread(y) > spread(x) ? y : x));
    details.push(
      `The least consistent arm was ${armPhrase(noisiest)}: its blocks varied by about ±${Math.round(100 * spread(noisiest))}%. More rounds (\`--rounds\`) narrow the intervals.`,
    );
  }
  details.push("“2× as fast” means the same work used twice as much of the 5-hour allowance, so the allowance lasts half as long.");
  return { headline: sentences[0], details };
}

/** A comment for anthropics/claude-code#97074, filled in from this report's numbers. */
function issueComment(runs, { arms, ref }, links = new Map()) {
  const m = runs.find((r) => r.meta.kind === "run")?.meta ?? runs[0].meta;
  const env = m.environment ?? {};
  const date = (m.startedAt ?? new Date().toISOString()).slice(0, 10);
  const lines = [
    `Results from a controlled A/B run with [claude-usage-ab](${REPO_URL}) ${describeHarness(m.harness, { link: true })} on ${date}: ${m.start?.subscription ?? "?"} plan, ${env.claudeVersion ?? "Claude Code ?"}, \`${m.model ?? "?"}\`${m.effort ? ` at ${m.effort} effort` : ""}.`,
    "",
    `| Entrypoint | Launched as | Blocks | Weighted tokens per 1% of the 5-hour window (95% CI) | Drains faster than \`${ref.name}\` by (95% CI) |`,
    "|---|---|---|---|---|",
  ];
  for (const a of arms) {
    lines.push(`| ${armName(a)} | ${armShort(a.name, a.sources)} | ${a.tokensPerPoint.n} | ${withCi(a.tokensPerPoint, fmtTokens)} | ${fmtRatio(a.ratio)} |`);
  }
  const verdict = conclusion({ arms, ref });
  lines.splice(2, 0, `**${verdict.headline}**`, "", ...verdict.details.slice(0, -1).flatMap((d) => [d, ""]));
  const emulated = arms.filter((a) => !a.sources.includes("watch") && !(a.name in ARM_SHORT)).map((a) => `\`${a.name}\``);
  const real = arms.filter((a) => a.sources.includes("watch")).map((a) => `\`${a.name}\``);
  lines.push(
    "",
    `Method: every arm ran an identical workload (read a generated corpus once, then one-word questions, so mostly cache reads) with no user settings, hooks or MCP servers, on the same CLI binary. The 5-hour meter: ${runs[0].meterUsed ?? "long-lived CLI session, cached about 60 s"}. Usage was measured in chained ${setting(m, "points") ?? 1}-point blocks with the arm order rotating.` +
      (emulated.length ? ` ${emulated.join(", ")} had its label set by the harness through \`CLAUDE_CODE_ENTRYPOINT\`.` : "") +
      (real.length ? ` ${real.join(", ")} is the real client, driven by hand with the same prompts.` : ""),
    "",
    `Full report${runs.length > 1 ? "s" : ""} with environment, token mix and every block: ${runs.map((r) => runRef(r, links)).join(", ")}`,
  );
  return lines.join("\n");
}

/** Markdown meant to be pasted into the issue: environment, method, results and per-block data. */
function bugReport(runs) {
  const analysis = analyze(runs);
  const { arms, ref } = analysis;
  const out = [
    "# Claude Code plan usage by entrypoint: A/B results",
    "",
    `Generated ${new Date().toISOString()} by [claude-usage-ab](${REPO_URL}) ${describeHarness(harnessInfo(), { link: true })} for [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074).`,
    "",
  ];
  if (arms.length === 0) return out.concat("No complete measurements yet.").join("\n");

  const verdict = conclusion(analysis);
  out.push("## Conclusion", "", `**${verdict.headline}**`, "", ...verdict.details.flatMap((d) => [d, ""]));
  out.push("## Results", "", armTable(analysis), "");

  out.push("## Environment", "", "| | |", "|---|---|");
  for (const run of runs) {
    const m = run.meta;
    const env = m.environment ?? {};
    out.push(
      `| Run \`${run.run}\` | ${m.kind ?? "?"}${m.label ? ` (${m.label})` : ""}, ${m.startedAt ?? "?"} → ${m.finishedAt ?? "?"} |`,
      `| claude-usage-ab | ${describeHarness(m.harness, { link: true })} |`,
      `| Command | ${m.command ? `\`${m.command}\`` : "?"} |`,
      `| Settings | ${m.settings ? Object.entries(m.settings).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(",") : v}`).join(", ") : "?"} |`,
      `| Meter | ${run.meterUsed ?? "long-lived CLI session (usage cached about 60 s)"} |`,
      `| Claude Code | ${env.claudeVersion ?? "?"} |`,
      `| Agent SDK | ${env.agentSdkVersion ?? "?"} |`,
      `| Plan | ${m.start?.subscription ?? "?"} |`,
      `| Model / effort | ${m.model ?? "set in client"} / ${m.effort ?? "default"} |`,
      `| OS / Node | ${env.os ?? "?"} / ${env.node ?? "?"} |`,
      `| 5-hour meter | ${m.start?.fiveHour ?? "?"}% → ${m.end?.fiveHour ?? "?"}% |`,
      `| Weekly meter | ${m.start?.sevenDay ?? "?"}% → ${m.end?.sevenDay ?? "?"}% |`,
      `| Stop reason | ${m.stopReason ?? "?"} |`,
    );
  }

  const scripted = runs.find((r) => r.meta.kind === "run")?.meta;
  out.push("", "## Method", "");
  out.push(
    "- Workload: a fresh session per block reads a generated text corpus" +
      (scripted ? ` (${setting(scripted, "files")} files × ${setting(scripted, "lines")} lines)` : "") +
      " with the Read tool, then answers one-word questions about it without tools. Every arm sends identical prompts.",
    "- Isolation: no setting sources (no hooks, CLAUDE.md, plugins or MCP servers), claude.ai connectors off, same CLI binary for all scripted arms. Inherited `CLAUDE_CODE_ENTRYPOINT` and related variables are removed.",
    "- Meter: the 5-hour utilization the CLI reports in a `rate_limit_event` whenever a request's response changes it, so every tick is placed at the request that caused it. The SDK's usage lookup is only a fallback: it refreshes about once a minute, which would credit up to a minute of one arm's usage to the next block.",
    `- Blocks: each block runs one arm until the meter ticks ${(scripted && setting(scripted, "points")) ?? 1} point(s) past the previous block's last tick. Blocks are chained, so the tokens in a block bought exactly the points it moved, ± one turn at each end. Arm order rotates every round. A warm-up up to the first tick is not counted.`,
    "- Tokens: weighted = input + 1.25 × cache write + 0.1 × cache read + 5 × output, from the SDK's per-model usage (scripted arms) or the session transcripts (manual arms). List-price $ is the SDK's `total_cost_usd`.",
    "- Guards: the run stops on any `rate_limit_event` with overage in use or a rejected status, at the configured 5-hour and weekly ceilings, or if the 5-hour window resets.",
    "",
    "How each arm was launched:",
    "",
  );
  for (const a of arms) out.push(`- \`${a.name}\`: ${armMethod(a.name, a.sources)}`);

  out.push(
    "",
    "## Token mix per arm",
    "",
    "Same workload, so the mix should match across arms. A different mix would point at a client difference rather than metering. The last column compares the SDK's usage count with the session transcript; a gap means model calls that are not written to the transcript.",
    "",
  );
  out.push("| Arm | Input | Cache write | Cache read | Output | Turns | SDK count vs. transcript |", "|---|---|---|---|---|---|---|");
  for (const a of arms) {
    const total = a.mix.input + a.mix.cacheWrite + a.mix.cacheRead + a.mix.output;
    const pct = (v) => `${((100 * v) / total).toFixed(1)}%`;
    const turns = a.spans.reduce((sum, s) => sum + (s.turns ?? 0), 0);
    const gap = a.transcriptGap === undefined ? "–" : `${a.transcriptGap >= 0 ? "+" : ""}${(100 * a.transcriptGap).toFixed(1)}%`;
    out.push(`| ${a.name} | ${pct(a.mix.input)} | ${pct(a.mix.cacheWrite)} | ${pct(a.mix.cacheRead)} | ${pct(a.mix.output)} | ${turns || "–"} | ${gap} |`);
  }

  out.push("", "## Blocks", "", "| Run | Block | Arm | Label | Points | Turns | Weighted tokens | List-price $ | Weighted tokens per point |", "|---|---|---|---|---|---|---|---|---|");
  for (const s of runs.flatMap((r) => r.spans)) {
    out.push(
      `| ${s.run} | ${s.block} | ${s.arm} | ${(s.labels ?? []).join(", ")} | ${s.points} | ${s.turns ?? "–"} | ${fmtTokens(weigh(s.tokens))} | ${s.costUsd == null ? "–" : s.costUsd.toFixed(2)} | ${fmtTokens(weigh(s.tokens) / s.points)} |`,
    );
  }
  out.push(
    "",
    "## Caveats",
    "",
    "- The meter reports whole percent. Blocks start and end on a tick, so each block carries up to about one turn of error at each end. Repeated blocks and the confidence intervals account for that.",
    "- Weighted tokens use list-price ratios. Metering may weight token types differently, but every arm runs the same mix.",
    "- Arms labelled by this harness only emulate the client's label; a `watch` run of the real client checks the emulation.",
    "- Other usage on the account during the run inflates whichever arm was running. The operator kept the account otherwise idle.",
    ...(runs.some((r) => r.meta.harness?.modified)
      ? ["- At least one run used a harness with local changes, so it cannot be reproduced exactly from a published version. Its script hash is in the Environment table."]
      : []),
    ...(runs.some((r) => !r.meterUsed)
      ? ["- At least one run predates 0.2.0 and logged no rate-limit events: its blocks rely on the usage lookup, which refreshes about once a minute and credits up to a minute of one arm's usage to the next block."]
      : []),
    ...(runs.some((r) => r.meterUsed?.includes("recomputed"))
      ? ["- At least one run predates 0.3.0: its blocks were recomputed from its logged rate-limit events. Its blocks did not end exactly on a meter tick, so each block's points are accurate to about one point."]
      : []),
    "",
    "Raw data: the `.jsonl` file of each run, next to its report, with every turn, every block and the run's metadata.",
    "",
    "## Issue comment",
    "",
    COMMENT_NOTE(runs),
    "",
    "```markdown",
    issueComment(runs, analysis),
    "```",
  );
  return out.join("\n");
}

/** For `run --test`: shows each arm ran and how it was labelled. Deliberately has no per-point numbers. */
function testReport(runs) {
  const lines = [
    "# Harness test (not a measurement)",
    "",
    `Generated ${new Date().toISOString()} by [claude-usage-ab](${REPO_URL}) ${describeHarness(harnessInfo(), { link: true })}.`,
    "",
    "Each arm ran two short turns on a tiny corpus. This checks that every arm starts, gets its expected label and is metered; it says nothing about relative usage.",
    "",
    "| Arm | Label in transcript | Turns | Weighted tokens | List-price $ | 5-hour meter after |",
    "|---|---|---|---|---|---|",
  ];
  for (const t of runs.flatMap((r) => r.tests)) {
    lines.push(`| ${t.arm} | ${t.labels.join(", ") || "none"} | ${t.turns} | ${fmtTokens(weigh(t.tokens))} | ${t.costUsd.toFixed(3)} | ${t.fiveHour}% |`);
  }
  const m = runs[0]?.meta;
  if (m) lines.push("", `claude-usage-ab ${describeHarness(m.harness)}. Command: \`${m.command ?? "?"}\``);
  if (m?.start) lines.push("", `5-hour meter ${m.start.fiveHour}% → ${m.end?.fiveHour ?? "?"}%, weekly ${m.start.sevenDay}% → ${m.end?.sevenDay ?? "?"}%.`);
  return lines.join("\n");
}

/** A meter point is a different number of tokens on each plan and model, and meter methods differ in resolution, so only runs that share all three are pooled. */
const runGroup = (r) =>
  r.meta.kind === "run" ? `${r.meta.start?.subscription ?? "?"} / ${r.meta.model ?? "?"} / ${r.meterUsed ?? "cached meter"}` : undefined;
const isComparable = (runs) => new Set(runs.map(runGroup).filter(Boolean)).size <= 1;
const isTestOnly = (runs) => runs.every((r) => r.meta.test);

/** Runs that cannot be pooled: one row per run, each arm compared with that run's own slowest arm. */
function collectedTable(runs, links = new Map()) {
  const rows = [];
  const tally = new Map();
  for (const run of runs.filter((r) => r.spans.length > 0)) {
    const { arms, ref } = analyze([run]);
    const m = run.meta;
    const others = arms.filter((a) => a.ratio);
    for (const a of others) {
      const t = tally.get(a.name) ?? { runs: 0, faster: 0 };
      t.runs++;
      if (!Number.isNaN(a.ratio.low) && a.ratio.low > 1) t.faster++;
      tally.set(a.name, t);
    }
    rows.push(
      `| ${links.has(run.run) ? runRef(run, links) : run.run} | ${describeHarness(m.harness)} | ${m.start?.subscription ?? "?"} | ${m.model ?? "set in client"} | ${m.environment?.claudeVersion ?? "?"} | \`${ref.name}\` | ${others.map((a) => `\`${a.name}\` ${fmtRatio(a.ratio)}`).join("; ") || "–"} |`,
    );
  }
  return [
    "| Run | claude-usage-ab | Plan | Model | Claude Code | Slowest arm (reference) | Other arms: drain the window faster by (95% CI) |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...[...tally].map(([name, t]) => `- \`${name}\` drained the window clearly faster than the run's slowest arm in ${t.faster} of ${t.runs} runs.`),
  ];
}

function collectedComment(runs, links = new Map()) {
  const unlinked = runs.filter((r) => r.spans.length > 0 && !links.has(r.run));
  return [
    `Collected results from ${runs.filter((r) => r.spans.length > 0).length} runs of [claude-usage-ab](${REPO_URL}) across different plans or models. Each row compares the arms within one run.`,
    "",
    ...collectedTable(runs, links),
    ...(unlinked.length ? ["", `Not merged yet, so not linked: ${unlinked.map((r) => `\`${r.run}\``).join(", ")}.`] : []),
  ].join("\n");
}

function collectedReport(runs) {
  return [
    "# Claude Code plan usage by entrypoint: collected results",
    "",
    `Generated ${new Date().toISOString()} by [claude-usage-ab](${REPO_URL}) ${describeHarness(harnessInfo(), { link: true })} for [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074).`,
    "",
    "These runs come from different plans or models. A point of the 5-hour window is a different number of tokens on each, so their blocks are not pooled. Each row is one run, with every arm compared against that run's slowest-draining arm. Each run's own report has the details.",
    "",
    ...collectedTable(runs),
    "",
    "## Issue comment",
    "",
    COMMENT_NOTE(runs),
    "",
    "```markdown",
    collectedComment(runs),
    "```",
  ].join("\n");
}

function renderReport(runs) {
  if (isTestOnly(runs)) return { report: testReport(runs), pooled: false };
  if (!isComparable(runs)) return { report: collectedReport(runs), pooled: false };
  return { report: bugReport(runs), pooled: true };
}

/** Writes the report to `file`; returns a short console summary. */
function writeReport(file, runs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { report, pooled } = renderReport(runs);
  fs.writeFileSync(file, report + "\n");
  return pooled ? armTable(analyze(runs)) : report;
}

const fmtDuration = (ms) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A status line rewritten every turn, and a lasting line per finished block with what is left. */
function makeProgress({ arms, rounds, points }) {
  const total = arms.length * rounds;
  let round = 0;
  let index = 0;
  const durations = [];
  const clear = () => process.stdout.write("\r\x1b[K");
  return {
    total,
    startRound: (r) => (round = r),
    startBlock: (i) => (index = i),
    turn({ block, arm, turn, fiveHour, target, elapsed }) {
      const where = block === 0 ? "Warm-up, not counted" : `Round ${round + 1}/${rounds} · block ${index}/${total} · ${arm}`;
      const goal = block === 0 ? `measuring starts when it reaches ${target}%` : `${Math.max(0, points - (target - fiveHour))} of ${points} points`;
      clear();
      process.stdout.write(`  ${where} · turn ${turn} · meter ${fiveHour}% · ${goal} · ${fmtDuration(elapsed)}`);
    },
    endBlock({ arm, result, got }) {
      clear();
      if (index === 0) {
        console.log(`  ✓ Warm-up: the meter reached ${result.fiveHour}% after ${result.turns} turns. Measuring starts now.`);
        return;
      }
      durations.push(result.seconds * 1000);
      const left = total - index;
      const average = durations.reduce((a, b) => a + b, 0) / durations.length;
      console.log(
        `  ✓ Block ${index}/${total} ${arm}: +${got} points in ${result.turns} turns (${fmtDuration(result.seconds * 1000)}), ${fmtTokens(weigh(result.tokens) / got)} weighted tokens per point` +
          (left ? `. Left: ${left} blocks, about ${left * points} points and ${fmtDuration(left * average)}.` : "."),
      );
    },
  };
}

const rotate = (list, by) => [...list.slice(by % list.length), ...list.slice(0, by % list.length)];

async function cmdRun(opts) {
  if (!opts.model) throw new Abort("--model is required, for example --model claude-opus-5-5.");
  const claude = resolveClaude(opts.claude);
  const arms = opts.arms.split(",").map((s) => s.trim()).filter(Boolean);
  // A test run checks the whole harness on a tiny corpus, two turns per arm, without waiting for meter ticks.
  if (opts.test) Object.assign(opts, { files: 2, lines: 20 });
  const base = opts.test ? resultsBase(opts.out, "test", TEST_RESULTS_DIR) : resultsBase(opts.out, "run");
  const meter = await openMeter(claude);
  try {
    const start = await meter.read();
    const environment = environmentInfo(claude);
    const plan = [
      `claude-usage-ab: ${describeHarness(harnessInfo(), { plain: true })}`,
      `Account: ${describeAccount(meter.account)}, ${start.subscription ?? "unknown"} plan`,
      `Claude binary: ${claude} (${environment.claudeVersion})`,
      `Model: ${opts.model}${opts.effort ? ` at ${opts.effort} effort` : ""}`,
      ...(opts.test
        ? [
            `Test mode: two short turns per arm (${arms.join(", ")}) on a tiny corpus. Checks the harness; the result is not a measurement.`,
            `Spend: a small fraction of one point of your 5-hour window (now ${start.fiveHour}%) with a small model.`,
          ]
        : [
            `Plan: a warm-up until the 5-hour meter next ticks (not counted), then ${opts.rounds} rounds. Each round runs every arm once (${arms.join(", ")}, order rotating), and each of these blocks lasts until it has moved the meter by ${opts.points} points: ${opts.rounds * arms.length} blocks in all.`,
            `Spend: about ${opts.rounds * arms.length * opts.points + 1} points of your 5-hour window, from ${start.fiveHour}% to about ${start.fiveHour + opts.rounds * arms.length * opts.points + 1}%, plus the matching share of your weekly limit (now ${start.sevenDay}%).`,
            `Stops early at ${opts.maxUtil}% (5-hour), ${opts.maxWeekly}% (weekly), on any sign of overage, or on Ctrl-C.`,
          ]),
      `Results: ${base}.md and ${base}.jsonl`,
    ];
    const needed = opts.test ? 1 : opts.rounds * arms.length * opts.points + 1;
    if (start.fiveHour + needed > opts.maxUtil) {
      const fits = Math.floor((opts.maxUtil - start.fiveHour - 1) / (arms.length * opts.points));
      throw new Abort(
        `Not enough room: ${start.fiveHour}% + about ${needed} points would pass --max-util ${opts.maxUtil}%. ` +
          (fits >= 2 ? `Use --rounds ${fits}, or wait for the window to reset.` : "Wait for the window to reset."),
      );
    }
    const log = new Log(base);
    // The corpus and Claude's stderr are scratch, so they stay out of the results that get committed.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-ab-"));
    const workspace = path.join(scratch, "workspace");
    const stderrPath = path.join(scratch, "stderr.log");
    const prompts = prepareWorkspace(workspace, opts);
    await preflight({ arms, claude, opts, cwd: workspace, stderrPath });
    await confirmSpend(plan, opts);

    const meta = {
      kind: "run",
      test: opts.test,
      startedAt: new Date().toISOString(),
      harness: harnessInfo(),
      command: commandLine(),
      settings: {
        arms,
        rounds: opts.rounds,
        points: opts.points,
        files: opts.files,
        lines: opts.lines,
        maxUtil: opts.maxUtil,
        maxWeekly: opts.maxWeekly,
        maxTurns: opts.maxTurns,
        claude: anonymizePath(claude),
      },
      meter: METER_METHOD,
      environment,
      model: opts.model,
      effort: opts.effort ?? null,
      start,
      stopReason: "running",
    };
    log.meta(meta);
    let stop = false;
    process.once("SIGINT", () => {
      stop = true;
      meta.stopReason = "interrupted";
      console.log("\nStopping after this turn...");
    });
    const progress = makeProgress({ arms, rounds: opts.rounds, points: opts.points });
    const ctx = { opts, meter, start, workspace, claude, prompts, stderrPath, progress, stopped: () => stop };
    try {
      if (opts.test) {
        for (const arm of arms) {
          if (stop) break;
          const testCtx = {
            ...ctx,
            opts: { ...opts, maxTurns: 2 },
            progress: { turn: ({ turn }) => process.stdout.write(`\r\x1b[K  Test · ${arm} · turn ${turn} of 2`) },
          };
          const result = await runBlock({ log, block: 0, arm, target: Infinity, ctx: testCtx });
          process.stdout.write(`\r\x1b[K  ✓ ${arm}: ran, labelled ${result.labels.join(", ") || "?"}\n`);
          log.write({ kind: "test", arm, turns: result.turns, tokens: result.tokens, costUsd: result.costUsd, labels: result.labels, fiveHour: result.fiveHour });
        }
        if (meta.stopReason === "running") meta.stopReason = "test complete";
        return;
      }
      // Spend up to the first meter tick, so every measured block starts right after one.
      progress.startBlock(0);
      const warmup = await runBlock({ log, block: 0, arm: arms[0], target: start.fiveHour + 1, ctx });
      meta.warmupTurns = warmup.turns;
      if (!warmup.reached) {
        if (meta.stopReason === "running") meta.stopReason = "warm-up did not reach a meter tick";
        return;
      }
      progress.endBlock({ arm: arms[0], result: warmup, got: 1 });
      let boundary = warmup.fiveHour;
      let measured = 0;
      let block = 0;
      // Whole rounds only, so every arm gets the same number of blocks.
      for (let round = 0; !stop && round < opts.rounds; round++) {
        if (block > 0) {
          const roundCost = (measured / block) * arms.length;
          if (boundary + roundCost > opts.maxUtil) {
            meta.stopReason = `another round (about ${Math.ceil(roundCost)} points) would pass --max-util ${opts.maxUtil}%`;
            break;
          }
        }
        progress.startRound(round);
        for (const arm of rotate(arms, round)) {
          if (stop) break;
          block++;
          progress.startBlock(block);
          const result = await runBlock({ log, block, arm, target: boundary + opts.points, ctx });
          if (!result.reached) {
            process.stdout.write("\n");
            if (meta.stopReason === "running") meta.stopReason = `block ${block} ended before its meter tick`;
            stop = true;
            break;
          }
          const points = result.fiveHour - boundary;
          log.write({
            kind: "span",
            source: "scripted",
            block,
            arm,
            points,
            tokens: result.tokens,
            transcriptTokens: result.transcriptTokens,
            costUsd: result.costUsd,
            turns: result.turns,
            labels: result.labels,
          });
          progress.endBlock({ arm, result, got: points });
          measured += points;
          boundary = result.fiveHour;
          if (result.fiveHour >= opts.maxUtil) (meta.stopReason = "5-hour ceiling reached"), (stop = true);
          if (result.sevenDay != null && result.sevenDay >= opts.maxWeekly) (meta.stopReason = "weekly ceiling reached"), (stop = true);
        }
        const verdict = conclusion(analyze(loadResults([log.file])));
        console.log(`\n  Round ${round + 1} of ${opts.rounds} done. So far: ${verdict.headline.replaceAll("`", "")}\n`);
      }
      if (meta.stopReason === "running") meta.stopReason = "all rounds measured";
    } catch (error) {
      meta.stopReason = `error: ${error?.message ?? error}`;
      console.error(`Claude's stderr: ${stderrPath}`);
      throw error;
    } finally {
      meta.finishedAt = new Date().toISOString();
      meta.end = await meter.read().catch(() => null);
      log.meta(meta);
      const runs = loadResults([log.file]);
      const summary = writeReport(log.report, runs);
      if (opts.test) {
        console.log(`\n${summary}\n\nTest report: ${log.report}`);
      } else {
        const verdict = conclusion(analyze(runs));
        console.log(`\n${summary}\n\nConclusion: ${[verdict.headline, ...verdict.details].join("\n").replaceAll("`", "")}\n\nReport: ${log.report}`);
      }
    }
  } finally {
    meter.close();
  }
}

async function cmdWatch(workspace, opts) {
  if (!workspace) throw new Abort("Usage: ab.mjs watch <workspace> --label <client>");
  const abs = path.resolve(workspace);
  // Claude Code stores a project's transcripts under its path with every non-alphanumeric character as "-".
  const projectDir = path.join(claudeHome(), "projects", abs.replace(/[^a-zA-Z0-9]/g, "-"));
  const label = opts.label ?? "manual";
  const log = new Log(resultsBase(opts.out, label));
  const claude = resolveClaude(opts.claude);
  const meter = await openMeter(claude);
  const tokensNow = () => transcriptUsage(listJsonl(projectDir));
  let stop = false;
  process.once("SIGINT", () => (stop = true));
  const meta = {
    kind: "watch",
    label,
    startedAt: new Date().toISOString(),
    harness: harnessInfo(),
    command: commandLine(),
    settings: { points: opts.points, blocks: opts.rounds, interval: opts.interval, maxUtil: opts.maxUtil },
    // A real client's rate-limit events never reach its transcripts, so only the lookup is available.
    meter: `usage lookup every ${opts.interval} s (refreshes about once a minute)`,
    environment: environmentInfo(claude),
    stopReason: "running",
  };
  try {
    const start = await meter.read();
    meta.start = start;
    log.meta(meta);
    console.log(`claude-usage-ab: ${describeHarness(meta.harness, { plain: true })}`);
    console.log(`Account: ${describeAccount(meter.account)}, ${start.subscription ?? "unknown"} plan`);
    console.log(`Watching ${projectDir}`);
    console.log(`5-hour window at ${start.fiveHour}%. Send the prompts from ${path.join(abs, "prompts.txt")} one at a time.`);
    console.log("Every prompt you send spends real plan usage. Ctrl-C stops watching and writes the report.");
    // Same chained spans as `run`, but sampled every --interval seconds instead of after every turn.
    let boundary;
    let spanStart = emptyTokens();
    let measured = 0;
    let block = 0;
    while (!stop && block < opts.rounds) {
      await new Promise((resolve) => setTimeout(resolve, opts.interval * 1000));
      const now = await meter.read();
      if (!sameWindow(start.fiveHourResetsAt, now.fiveHourResetsAt)) throw new Abort("The 5-hour window reset. Start again.");
      const { total, entrypoints } = tokensNow();
      log.write({ kind: "sample", block, arm: label, tokens: total, weighted: weigh(total), fiveHour: now.fiveHour, sevenDay: now.sevenDay, at: new Date().toISOString() });
      if (boundary === undefined) {
        if (now.fiveHour > start.fiveHour) {
          boundary = now.fiveHour;
          spanStart = total;
        }
      } else if (now.fiveHour >= boundary + opts.points) {
        block++;
        const points = now.fiveHour - boundary;
        log.write({ kind: "span", source: "watch", block, arm: label, points, tokens: subtractTokens(total, spanStart), costUsd: null, labels: entrypoints });
        measured += points;
        boundary = now.fiveHour;
        spanStart = total;
      }
      process.stdout.write(
        `\r[${label}] 5h ${now.fiveHour}%  ${boundary === undefined ? "warming up to the first tick" : `${block}/${opts.rounds} blocks, ${measured} points measured`}  labels: ${entrypoints.join(",") || "none yet"}   `,
      );
      if (now.fiveHour >= opts.maxUtil) {
        meta.stopReason = "5-hour ceiling reached";
        console.log(`\nStopping: 5-hour window at ${now.fiveHour}%.`);
        break;
      }
    }
    if (block >= opts.rounds) {
      meta.stopReason = "all blocks measured";
      console.log("\nBudget reached. Stop sending prompts.");
    } else if (stop) meta.stopReason = "interrupted";
  } catch (error) {
    meta.stopReason = `error: ${error?.message ?? error}`;
    throw error;
  } finally {
    meta.finishedAt = new Date().toISOString();
    meta.end = await meter.read().catch(() => null);
    meter.close();
    log.meta(meta);
    const summary = writeReport(log.report, loadResults([log.file]));
    console.log(`\n${summary}\n\nIssue-ready report, including a comment to paste: ${log.report}`);
  }
}

async function cmdPrepare(dir, opts) {
  if (!dir) throw new Abort("Usage: ab.mjs prepare <dir>");
  const prompts = prepareWorkspace(path.resolve(dir), opts);
  const all = [firstPrompt(randomUUID(), prompts.files), ...prompts.questions];
  fs.writeFileSync(path.join(dir, "prompts.txt"), all.map((p, i) => `--- prompt ${i + 1} ---\n${p}\n`).join("\n"));
  console.log(`Workspace ready: ${path.resolve(dir)}. Send prompts.txt one prompt at a time, waiting for each answer.`);
}

async function cmdProbe(opts) {
  const claude = resolveClaude(opts.claude);
  const probe = await openProbe(claude);
  try {
    const usage = await readUsage(probe.q);
    console.log(
      [
        `claude-usage-ab: ${describeHarness(harnessInfo(), { plain: true })}`,
        `Account:         ${describeAccount(probe.account)}`,
        `Plan:            ${usage.subscription ?? probe.account.subscriptionType ?? "unknown"}`,
        `Claude Code:     ${environmentInfo(claude).claudeVersion} (${claude})`,
        `5-hour usage:    ${usage.fiveHour}% used${describeReset(usage.fiveHourResetsAt)}`,
        `Weekly usage:    ${usage.sevenDay ?? "?"}% used${describeReset(usage.sevenDayResetsAt)}`,
      ].join("\n"),
    );
  } finally {
    probe.close();
  }
}

function cmdReport(files, opts) {
  if (files.length === 0) throw new Abort("Usage: ab.mjs report <results .jsonl files...> [--out <folder>]");
  const runs = loadResults(files.map((f) => path.resolve(f)));
  const file = freshPath(path.resolve(opts.out ?? REPORTS_DIR), `report-${fileStamp()}`, ".md");
  writeReport(file, runs);
  console.log(`Wrote ${file}`);
}

/** Prints the issue comment, linking only reports already merged on GitHub; notes go to stderr. */
async function cmdComment(files) {
  if (files.length === 0) throw new Abort("Usage: ab.mjs comment <results .jsonl files...>");
  const runs = loadResults(files.map((f) => path.resolve(f)));
  if (isTestOnly(runs)) throw new Abort("Test runs measure nothing, so they have no issue comment.");
  const links = await publishedLinks(runs);
  console.log(isComparable(runs) ? issueComment(runs, analyze(runs), links) : collectedComment(runs, links));
  const unlinked = runs.filter((r) => !links.has(r.run)).map((r) => r.run);
  if (unlinked.length) {
    console.error(`\nNot on main at ${REPO_URL} yet, so not linked: ${unlinked.join(", ")}. Run this again once the pull request is merged.`);
  }
}

const COMMANDS = {
  probe: { usage: "probe", summary: "Show the account, plan and usage meters. Free." },
  run: {
    usage: "run --model <id> [options]",
    summary: "Compare the arms on this account. Spends plan usage and asks first.",
    detail:
      "Runs a warm-up until the 5-hour meter next ticks, then --rounds rounds. Each round runs every arm once, in rotating order, and each of these blocks lasts until it has moved the meter by --points points. Before starting it shows the plan, the expected spend and where your meter should end up, and asks you to type yes. Writes results/<time>-run.md (the report) and .jsonl (the data).",
  },
  prepare: {
    usage: "prepare <dir> [options]",
    summary: "Create a workspace and prompts for measuring a real client by hand. Free.",
  },
  watch: {
    usage: "watch <dir> --label <client> [options]",
    summary: "Measure a real client while you send the prompts from <dir>/prompts.txt. Your prompts spend usage.",
    detail:
      "Reads the 5-hour meter every --interval seconds and the tokens from the client's transcripts for <dir>, and records --rounds blocks of --points points. Create <dir> with prepare first.",
  },
  report: {
    usage: "report <results .jsonl files...> [--out <folder>]",
    summary: "Write a report combining runs. Free.",
    detail: "Pools runs that share plan, model and meter method; lists other runs one row each. Never overwrites: writes a new report-<time>.md.",
  },
  comment: {
    usage: "comment <results .jsonl files...>",
    summary: "Print the issue comment, linking only reports already merged on GitHub. Free.",
  },
  version: { usage: "version", summary: "Show this app's version and commit." },
};

/** Every option, with the commands it applies to; parsing, defaults and --help all come from here. */
const OPTIONS = {
  model: { type: "string", value: "<id>", for: ["run"], help: "Model for every arm, for example claude-opus-5-5 or claude-haiku-5-5. Required." },
  effort: { type: "string", value: "<level>", for: ["run"], help: "low, medium, high, xhigh or max. Default: the CLI's default." },
  test: { type: "boolean", for: ["run"], help: "Two short turns per arm on a tiny corpus: checks the setup, measures nothing. Writes to test-results/." },
  arms: {
    type: "string",
    value: "<list>",
    default: `${ARM_SDK_DEFAULT},${ARM_PRINT_MODE},claude-vscode`,
    for: ["run"],
    help: "Comma-separated arms to compare. Any other value is set as CLAUDE_CODE_ENTRYPOINT.",
  },
  rounds: { type: "string", value: "<n>", default: "3", number: true, for: ["run", "watch"], help: { run: "Rounds to measure; each runs every arm once.", watch: "Blocks to measure." } },
  points: { type: "string", value: "<n>", default: "2", number: true, for: ["run", "watch"], help: "Meter points each block must move." },
  files: { type: "string", value: "<n>", default: "2", number: true, for: ["run", "prepare"], help: "Files in the generated corpus." },
  lines: { type: "string", value: "<n>", default: "1000", number: true, for: ["run", "prepare"], help: "Lines per corpus file." },
  "max-turns": { type: "string", value: "<n>", default: "400", number: true, for: ["run", "prepare"], help: { run: "Turn limit per block.", prepare: "Questions to write to prompts.txt." } },
  "max-util": { type: "string", value: "<pct>", default: "85", percent: true, for: ["run", "watch"], help: "Stop when the 5-hour meter reaches this." },
  "max-weekly": { type: "string", value: "<pct>", default: "95", percent: true, for: ["run"], help: "Stop when the weekly meter reaches this." },
  interval: { type: "string", value: "<s>", default: "15", number: true, for: ["watch"], help: "Seconds between meter readings." },
  label: { type: "string", value: "<client>", for: ["watch"], help: "Name of the client being measured, for example vscode-real." },
  claude: { type: "string", value: "<path>", for: ["run", "watch", "probe", "version"], help: "Claude Code binary to use. Default: claude on PATH." },
  out: {
    type: "string",
    value: "<path>",
    for: ["run", "watch", "report"],
    help: { run: "Where to write the .md and .jsonl, without extension.", watch: "Where to write the .md and .jsonl, without extension.", report: "Folder for the report. Default: reports/." },
  },
  yes: { type: "boolean", short: "y", for: ["run"], help: "Start without asking. The spend is still shown." },
  version: { type: "boolean", short: "v", help: "Show this app's version and commit." },
  help: { type: "boolean", short: "h", help: "Show help." },
};

function help(command) {
  const version = `claude-usage-ab ${describeHarness(harnessInfo(), { plain: true })}`;
  const spec = COMMANDS[command];
  if (!spec) {
    const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
    return [
      `${version}: measures whether Claude Code's 5-hour plan limit drains faster per token depending on the client that runs it.`,
      "",
      "Usage: node ab.mjs <command> [options]",
      "",
      "Commands:",
      ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
      "",
      "Run node ab.mjs <command> --help for its options. Docs: README.md",
    ].join("\n");
  }
  const options = Object.entries(OPTIONS).filter(([, o]) => o.for?.includes(command));
  const flag = ([name, o]) => `${o.short ? `-${o.short}, ` : "    "}--${name}${o.value ? ` ${o.value}` : ""}`;
  const width = Math.max(...options.map(flag).map((f) => f.length), 14);
  const text = (o) => (typeof o.help === "string" ? o.help : o.help[command]) + (o.default ? ` Default: ${o.default}.` : "");
  return [
    `Usage: node ab.mjs ${spec.usage}`,
    "",
    spec.detail ?? spec.summary,
    ...(options.length ? ["", "Options:", ...options.map((entry) => `  ${flag(entry).padEnd(width)}  ${text(entry[1])}`)] : []),
    `  ${"-h, --help".padEnd(width)}  Show this help.`,
  ].join("\n");
}

/** Parses the command line; mistakes come back as a short message that points to --help. */
function parseCommandLine() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: Object.fromEntries(
        Object.entries(OPTIONS).map(([name, o]) => [
          name,
          { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.default ? { default: o.default } : {}) },
        ]),
      ),
    });
  } catch (error) {
    const command = process.argv.slice(2).find((a) => !a.startsWith("-"));
    throw new Abort(`${String(error.message).split(". ")[0]}. See node ab.mjs ${command && COMMANDS[command] ? `${command} ` : ""}--help.`);
  }
  const { values, positionals, tokens } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || values.version) return { command, rest, values };
  if (command && !COMMANDS[command]) throw new Abort(`Unknown command "${command}". See node ab.mjs --help.`);
  for (const token of tokens.filter((t) => t.kind === "option")) {
    const o = OPTIONS[token.name];
    if (command && o.for && !o.for.includes(command)) {
      throw new Abort(`--${token.name} does not apply to ${command}. See node ab.mjs ${command} --help.`);
    }
    if (o.number || o.percent) {
      const n = Number(token.value);
      const ok = Number.isInteger(n) && n > 0 && (!o.percent || n <= 100);
      if (!ok) throw new Abort(`--${token.name} needs ${o.percent ? "a whole percentage from 1 to 100" : "a whole number above 0"}, not "${token.value}".`);
    }
  }
  return { command, rest, values };
}

try {
  const { command, rest, values } = parseCommandLine();
  const opts = {
    ...values,
    points: Number(values.points),
    rounds: Number(values.rounds),
    maxUtil: Number(values["max-util"]),
    maxWeekly: Number(values["max-weekly"]),
    maxTurns: Number(values["max-turns"]),
    files: Number(values.files),
    lines: Number(values.lines),
    interval: Number(values.interval),
  };
  if (values.help) console.log(help(command));
  else if (values.version || command === "version") console.log(`claude-usage-ab ${describeHarness(harnessInfo(), { plain: true })}`);
  else if (command === "run") await cmdRun(opts);
  else if (command === "watch") await cmdWatch(rest[0], opts);
  else if (command === "prepare") await cmdPrepare(rest[0], opts);
  else if (command === "probe") await cmdProbe(opts);
  else if (command === "report") cmdReport(rest, opts);
  else if (command === "comment") await cmdComment(rest);
  else {
    console.log(help());
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Abort ? error.message : error);
  process.exitCode = 1;
}
// The SDK can keep handles open after close(); this is a one-shot CLI.
process.exit();
