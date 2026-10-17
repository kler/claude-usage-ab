# claude-usage-ab

A test harness that measures whether Claude Code's 5-hour plan window drains faster per token depending on which client launched it. Background: [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074).

It compares three ways of running the same Claude Code session:

| Arm | Launched as | Label the CLI records |
|---|---|---|
| `sdk-ts` | Agent SDK, label left to the SDK. This is how SDK apps such as T3 Code run Claude. | `sdk-ts` |
| `sdk-cli` | The same launch plus `-p` and no label, so the CLI labels itself. This is what `claude -p --input-format stream-json` does. | `sdk-cli` |
| `claude-vscode` | The same launch with `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, emulating the VS Code extension. | `claude-vscode` |

Each run produces a Markdown report with a draft issue comment. **Please contribute your reports**: results from many plans, models and machines are what make the answer convincing. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Why the arms are comparable

The Claude Code VS Code extension (checked on 2.1.301) runs Claude the same way SDK apps do:

- It bundles the Agent SDK's process transport and starts its bundled `claude` binary with `--output-format stream-json --verbose --input-format stream-json`.
- It sets `CLAUDE_CODE_ENTRYPOINT=claude-vscode`. The SDK's default is `sdk-ts`, and the CLI picks `sdk-cli` for itself in print mode.
- The CLI sends this label with every request, in the `cc_entrypoint` field of an `x-anthropic-billing-header` system block.

The harness runs all arms through one SDK launch path with the same binary, prompts, settings and environment. The three extra variables the extension sets (`MCP_CONNECTION_NONBLOCKING`, `CLAUDE_CODE_ENABLE_TASKS=0`, `CLAUDE_CODE_EMIT_STARTUP_TIMING`) are applied to every arm. Only the way the label comes about differs.

The `claude-vscode` arm only emulates the label. A `watch` run of the real extension (see below) checks that the emulation matches the real thing.

## How it measures

Each measurement pairs two numbers from two different sources:

- **Tokens come from the client.** For scripted arms, the SDK's per-model usage for the session. As a cross-check, the session's transcript count is stored too: model calls the CLI makes without writing them to the transcript would show up as a gap. For `watch`, tokens come from the client's transcripts.
- **Usage comes from the account.** The plan meter is the only place the account's response to those tokens can be seen, and it is account-wide: there is no per-session or per-client meter. After every turn, a fresh session that never sends a prompt reads it through the SDK's usage call, which costs no tokens. The meter value itself refreshes only about once a minute, and a long-lived session would add up to another minute of its own caching on top.
- **Rate-limit events are logged too.** Every `rate_limit_event` the session receives is stored raw, as a candidate for a finer meter.

Both are stored for every turn.

**Blocks.**
- A block runs one arm in a fresh session. The session reads a generated text corpus once, then answers one-word questions about it. Most of each turn's tokens are cache reads, as in real agent use.
- A block lasts until the meter ticks `--points` past where the previous block ended (default 2). Because the meter refreshes about once a minute, a block lasts at least a minute; on a large model that can be several points. Blocks are chained back to back, so the tokens in a block bought exactly the points it moved, give or take one turn at each end. No usage is wasted waiting for a first tick, apart from one warm-up at the start.
- The arm order rotates every round, so drift over time and the carry-over between neighbouring blocks affect every arm equally.

**Metric.** Weighted tokens per point: `input + 1.25 × cache write + 0.1 × cache read + 5 × output`. The report also shows list-price dollars per point (the SDK's `total_cost_usd`), 95% confidence intervals per arm, and how many times faster each arm drains the window than the slowest one.

**Statistics.** These come from repeated short blocks rather than one long run. The run measures whole rounds, one block per arm each, so every arm gets the same number of blocks. The default of 3 rounds is enough to separate a 2× effect. Raise `--rounds` to narrow the intervals.

## Safety

- `run` sends real prompts and spends real plan usage. It shows the account, plan and expected spend, and asks you to type `yes`. `--yes` (`-y`) skips the question, for scripted use.
- Before asking, it starts every arm without a prompt, so a broken setup fails before anything is spent.
- It stops on any sign of overage or a rejected request, at `--max-util` (5-hour, default 85%), at `--max-weekly` (default 95%), on Ctrl-C, or if the 5-hour window resets mid-run.
- **Nothing else may use the account while it runs**, on any device. Because the meter is account-wide, other usage (including an AI coding session you used to set this up) is counted against whichever arm was running. Rotation turns that into noise rather than a skew toward one arm, but it widens the intervals; such blocks show up as outliers in the report's block table.

## Use

Requires Node 20+ and a Claude Code login with a claude.ai subscription. Unset `ANTHROPIC_API_KEY`.

```sh
npm install
node ab.mjs probe                                      # account, plan and meter; costs nothing
node ab.mjs run --test --model claude-haiku-5-5        # check everything works; a small fraction of a point
node ab.mjs run --model claude-opus-5-5 --effort high  # the measurement; reports its cost per round after the warm-up
```

`probe` shows which account the CLI is logged in as. If you use several accounts, run it first: the harness uses whatever account `claude` uses, including any `CLAUDE_CONFIG_DIR` you set.

To match the real VS Code extension exactly, pass its bundled binary to every command with `--claude`, for example `~/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude`.

### `run --test`

Runs every arm for two short turns on a tiny corpus. It goes through the whole pipeline: launch, meter, labels, logs and report. It doesn't wait for meter ticks, so it measures nothing. Use a small model. Its output goes to `test-results/`, which git ignores.

### `run` options

| Option | Default | Meaning |
|---|---|---|
| `--model` | (required) | Model for every arm. Use the one whose usage you care about. |
| `--effort` | CLI default | Effort level for every arm. |
| `--arms` | `sdk-ts,sdk-cli,claude-vscode` | Arms to compare. Any other value is set as `CLAUDE_CODE_ENTRYPOINT`. |
| `--rounds` | `3` | Rounds to measure; each runs one block per arm. Before each round the run checks it fits under `--max-util`. |
| `--points` | `2` | Meter points per block. More points per block means less rounding error per block, at a higher cost. |
| `--files`, `--lines` | `2`, `1000` | Corpus size, about 25k tokens. Each block is measured to within about one turn at each end, so smaller turns (a smaller corpus) give finer measurements; larger turns finish faster. Keep it well under the context window so auto-compaction never runs. |
| `--max-util`, `--max-weekly` | `85`, `95` | Stop ceilings in percent. |
| `--claude` | `claude` on PATH | The Claude Code binary every arm uses. |
| `--out` | `results/<time>-run` | Where to write the run's `.jsonl` and `.md`, without extension. An existing run is refused. |
| `--yes`, `-y` | off | Skip the confirmation question. |

## Checking against a real client

```sh
node ab.mjs prepare ws-vscode
node ab.mjs watch ws-vscode --label vscode-real
```

1. Open `ws-vscode` in VS Code and start a Claude session there.
2. Use the same model and effort as the scripted run. Turn off hooks and MCP servers.
3. Send the prompts from `ws-vscode/prompts.txt` one at a time.

`watch` reads the meter every 15 seconds and the tokens from that workspace's transcripts. It records blocks the same way `run` does, `--rounds` of them, and says when to stop. Ctrl-C stops it early.

The same works for any client that runs Claude Code in a folder, such as an Agent SDK app; give it its own `--label`.

## Results and reports

Every `run` and `watch` writes two files under `results/`, named with the UTC start time:

- `results/2026-10-17T10-30-00Z-run.md`: the report. It has the result with confidence intervals, environment, method, how each arm was launched, token mix per arm, every block and caveats. It ends with a draft **issue comment** filled in from the results. The report is written before it is merged here, so the draft has no link to it yet; see [Posting to the issue](#posting-to-the-issue).
- `results/2026-10-17T10-30-00Z-run.jsonl`: the raw data. Every turn and every block with both token counts and the meter readings, plus the run's metadata: versions, plan, model, meter at start and end, stop reason.

Times are ISO 8601 with `-` in place of `:`, so they are valid file names everywhere. The generated corpus and Claude's stderr go to a temporary folder, not the repo.

To combine runs:

```sh
node ab.mjs report results/<run>.jsonl results/<vscode-real>.jsonl   # writes reports/report-<time>.md
```

Runs on the same plan and model are pooled. Runs from different plans or models are not, because a point of the 5-hour window is a different number of tokens on each. The report then shows one row per run, each compared against its own slowest arm, and counts in how many runs each arm drained faster. Reports are never overwritten: every `report` call writes a new file.

The report states which labels were set by this harness. Keep that line when you post the results.

## Posting to the issue

Once a report is merged into this repository, print its issue comment with a working link:

```sh
node ab.mjs comment results/2026-10-17T10-30-00Z-run.jsonl
```

It checks on GitHub which of the given reports are on `main` and links only those; the others are marked "not merged yet", with a note on stderr. Several runs can be given at once; runs from different plans or models then become one row each. The comment goes to stdout, so it can be piped, for example into `gh issue comment 97074 --repo anthropics/claude-code --body-file -`.

## Versions

Every result records how it was produced: the claude-usage-ab version (`package.json`, also shown by `node ab.mjs --version`), the git commit, whether the harness files had local changes (with a hash of the script that ran), the exact command, every setting including defaults, and the meter method. The report shows all of it. Runs recorded before 0.2.0 show the harness as unknown and are never pooled with later ones, because they read the meter through a long-lived session.

## Privacy

Results hold no account email, names or home-directory paths. They do record the plan type, model, Claude Code and SDK versions, OS and Node version. A pull request also shows your GitHub account, and commits show your git author name and email.
