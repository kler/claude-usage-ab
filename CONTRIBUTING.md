# Contributing

## Contribute your results

The most useful contribution is a report from your own account. One run says something about one plan, model and machine; many runs say whether the effect is general. Every report is welcome, including ones that show no difference.

1. Follow [Use](README.md#use): `probe`, then `run --test`, then a real `run`. Keep the account otherwise idle while it runs.
2. Check the report's environment table. The stop reason should be `budget measured`. If the run was interrupted or something else used the account, say so in the pull request, or run again.
3. Commit the run's two files, and nothing from `test-results/`:

   ```sh
   git add results/2026-10-17T10-30-00Z-run.md results/2026-10-17T10-30-00Z-run.jsonl
   git commit -m "results: team plan, claude-opus-5-5, Claude Code 2.1.301"
   ```

4. Open a pull request (see [Workflow](#workflow)). In the description, mention anything unusual: other usage on the account, a different `--budget`, a custom `--claude` binary.

Real-client `watch` runs are welcome as well, for example the real VS Code extension next to a scripted run on the same plan and model.

Never edit or delete someone else's results. To correct a result, add a new run.

Once your results are merged, you can paste the issue comment from your report into [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074). Its link points to your report in this repository.

## Contribute code

- Open an issue first for anything larger than a fix, so we can agree on the approach.
- Keep the harness small: one script, no build step, one dependency.
- Check a change with `node ab.mjs run --test --model <small model>`, and with `node ab.mjs report` on existing results if it touches reporting.
- If a change alters what a measurement means, say so in the pull request. Earlier results must stay readable.

## Workflow

This repository keeps a linear history: pull requests are rebased onto `main`, never merged with a merge commit.

```sh
# once
git clone https://github.com/<you>/claude-usage-ab.git
cd claude-usage-ab
git remote add upstream https://github.com/kler/claude-usage-ab.git
npm install

# per contribution
git fetch upstream
git switch -c <branch> upstream/main
# ...work, commit...
git push -u origin <branch>
```

Then open a pull request against `kler/claude-usage-ab:main`.

If `main` moves while your pull request is open, rebase instead of merging:

```sh
git fetch upstream
git rebase upstream/main
git push --force-with-lease
```

Keep each commit self-contained, with a short subject in the form `<type>: <summary>`. Types: `results`, `feat`, `fix`, `docs`.
