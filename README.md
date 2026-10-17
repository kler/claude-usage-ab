# claude-usage-ab

A test harness that measures whether Claude Code's 5-hour plan window drains faster per token depending on which client launched it. Background: [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074). Repository: https://github.com/kler/claude-usage-ab

It compares three ways of running the same Claude Code session:

| Arm | Launched as | Label the CLI records |
|---|---|---|
| `sdk-ts` | Agent SDK, label left to the SDK. This is how SDK apps such as T3 Code run Claude. | `sdk-ts` |
| `sdk-cli` | The same launch plus `-p` and no label, so the CLI labels itself. This is what `claude -p --input-format stream-json` does. | `sdk-cli` |
| `claude-vscode` | The same launch with `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, emulating the VS Code extension. | `claude-vscode` |

The output is a Markdown report you can paste into the issue.

## Why the arms are comparable

The Claude Code VS Code extension (checked on 2.1.301) runs Claude the same way SDK apps do:

- It bundles the Agent SDK's process transport and starts its bundled `claude` binary with `--output-format stream-json --verbose --input-format stream-json`.
- It sets `CLAUDE_CODE_ENTRYPOINT=claude-vscode`. The SDK's default is `sdk-ts`, and the CLI picks `sdk-cli` for itself in print mode.
- The CLI sends this label with every request, in the `cc_entrypoint` field of an `x-anthropic-billing-header` system block.

The harness runs all arms through one SDK launch path with the same binary, prompts, settings and environment. The three extra variables the extension sets (`MCP_CONNECTION_NONBLOCKING`, `CLAUDE_CODE_ENABLE_TASKS=0`, `CLAUDE_CODE_EMIT_STARTUP_TIMING`) are applied to every arm. Only the way the label comes about differs.

The `claude-vscode` arm only emulates the label. A `watch` run of the real extension (see below) checks that the emulation matches the real thing.

## How it measures

**Meter.** A separate session that never sends a prompt reads the 5-hour utilization through the SDK's usage call. This costs no tokens, unlike a probe prompt.

**Blocks.**
- A block runs one arm in a fresh session. The session reads a generated text corpus once, then answers one-word questions about it. Most of each turn's tokens are cache reads, as in real agent use.
- A block lasts until the meter ticks `--points` past where the previous block ended (default 1). Blocks are chained back to back, so the tokens in a block bought exactly the points it moved, give or take one turn at each end. No usage is wasted waiting for a first tick, apart from one warm-up at the start.
- The arm order rotates every round, so drift over time and the carry-over between neighbouring blocks affect every arm equally.

**Metric.** Weighted tokens per point: `input + 1.25 × cache write + 0.1 × cache read + 5 × output`. The report also shows list-price dollars per point (the SDK's `total_cost_usd`), 95% confidence intervals per arm, and how many times faster each arm drains the window than the slowest one.

**Statistics.** These come from repeated short blocks rather than one long run. The default measures 9 points, 3 blocks per arm, which is enough to separate a 2× effect and most smaller ones. Raise `--budget` to narrow the intervals.

## Safety

- `run` sends real prompts and spends real plan usage. It shows what it will spend and asks you to type `yes`. `--yes` (`-y`) skips the question, for scripted use.
- Before asking, it starts every arm without a prompt, so a broken setup fails before anything is spent.
- It stops on any sign of overage or a rejected request, at `--max-util` (5-hour, default 85%), at `--max-weekly` (default 95%), on Ctrl-C, or if the 5-hour window resets mid-run.
- **Nothing else may use the account while it runs**, on any device. That includes AI coding sessions such as the one you may have used to set this up. Any other usage is counted against whichever arm was running.

## Use

Requires Node 20+ and a Claude Code login with a claude.ai subscription. Unset `ANTHROPIC_API_KEY`.

```sh
npm install
node ab.mjs probe                                      # read the meter; costs nothing
node ab.mjs run --test --model claude-haiku-5-5        # check everything works; a small fraction of a point
node ab.mjs run --model claude-opus-5-5 --effort high  # the measurement; about --budget + 1 points
```

To match the real VS Code extension exactly, pass its bundled binary to every command with `--claude`, for example `~/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude`.

### `run --test`

Runs every arm for two short turns on a tiny corpus. It goes through the whole pipeline: launch, meter, labels, logs and report. It doesn't wait for meter ticks, so it measures nothing. Use a small model.

### `run` options

| Option | Default | Meaning |
|---|---|---|
| `--model` | (required) | Model for every arm. Use the one whose usage you care about. |
| `--effort` | CLI default | Effort level for every arm. |
| `--arms` | `sdk-ts,sdk-cli,claude-vscode` | Arms to compare. Any other value is set as `CLAUDE_CODE_ENTRYPOINT`. |
| `--budget` | `9` | Meter points to measure, across all arms. The run spends about this plus 1. |
| `--points` | `1` | Meter points per block. |
| `--files`, `--lines` | `8`, `1000` | Corpus size, about 100k tokens of context. Larger means fewer, bigger turns per point (faster, coarser). Keep it well under the context window so auto-compaction never runs. |
| `--max-util`, `--max-weekly` | `85`, `95` | Stop ceilings in percent. |
| `--claude` | `claude` on PATH | The Claude Code binary every arm uses. |
| `--out` | `results/<timestamp>-run` | Results folder. A folder that already holds a run is refused. |
| `--yes`, `-y` | off | Skip the confirmation question. |

## Checking against a real client

```sh
node ab.mjs prepare ws-vscode
node ab.mjs watch ws-vscode --label vscode-real
```

1. Open `ws-vscode` in VS Code and start a Claude session there.
2. Use the same model and effort as the scripted run. Turn off hooks and MCP servers.
3. Send the prompts from `ws-vscode/prompts.txt` one at a time.

`watch` reads the meter every 15 seconds and the tokens from that workspace's transcripts. It records 1-point blocks the same way `run` does, and says when the budget is reached. Ctrl-C stops it early.

The same works for any client that runs Claude Code in a folder, such as an Agent SDK app; give it its own `--label`.

## Reports

Every `run` and `watch` writes a folder under `results/` named with the UTC start time, for example `results/2026-10-17T10-30-00Z-run/`. Times use ISO 8601 with `-` in place of `:` so they are valid file names everywhere. The folder contains:

- `report-<time>.md`: the report for the issue. It has the result with confidence intervals, environment, method, how each arm was launched, token mix per arm, every block and caveats. At the end is an **issue comment** filled in from the results and linking to the report in this repository, ready to paste.
- `samples.jsonl`: every turn and every block.
- `meta.json`: versions, plan, meter readings at start and end, and the stop reason.

Reports are never overwritten. Each `report` call writes a new file with its own timestamp.

To combine runs, for example a scripted run with real-client checks:

```sh
node ab.mjs report results/<run> results/<vscode-real>   # writes reports/report-<time>.md
```

The report states which labels were set by this harness. Keep that line when you post the results.

## Sharing results

Results are meant to be committed, so the issue comment can link to them. Commit the run folder (and any combined report under `reports/`), then push before posting the comment. The generated corpus and `stderr.log` stay out of git.

Committed files hold no names or home-directory paths, but your git commit records your git author identity.
