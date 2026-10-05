# tdd-mod

[![CI](https://github.com/koslowskyj/tdd-mod/actions/workflows/ci.yml/badge.svg)](https://github.com/koslowskyj/tdd-mod/actions/workflows/ci.yml)

> **Experimental.** This is an experiment in enforcing test-driven development
> on a coding agent. It works in a kata, has not been used on a real codebase
> yet, and its settings, behaviour and the Claude Code API it is built on may
> change without notice.

A Claude Code mod that keeps the agent to **Red → Green → Refactor**. Before
each file write on a coding task, a judge model checks the write against the
TDD rules and blocks it, with the reason, when it skips a failing test or
implements more than the failing test needs. The agent reads the reason and
corrects course.

The TDD rules and the judging approach are ported from
[probity](https://github.com/nizos/probity)'s `enforceTdd` rule (MIT). Probity
runs as an external `PreToolUse` command; tdd-mod runs in-process as a Claude
Code *function-hooks plugin* (a "mod"), so it needs no extra install, API key
or process per write.

## What it does

- **Judges every write to a source file:** `Write`, `Edit` and `NotebookEdit`.
  The judge sees the last 10 prompts and tool calls of the session, the file as
  it is, and the file as the write would leave it, and answers pass or
  violation.
- **The judge sees the last test run**, however long ago: its command, whether
  it was red or green, and its output. So a fix for a failure the agent has
  already seen is judged as the green step it is.
- **Refactors pass while green.** When the last test run was green, the judge
  is told that this may be the refactor step: extracting a helper from existing
  code, inlining, renaming, or removing unused code passes without a new
  failing test, unless the change adds behaviour.
- **Only on coding tasks.** Each prompt you type is labelled *coding* (adds,
  changes or fixes behaviour) or *other* (moving or renaming code, extracting,
  formatting, docs, config, questions, git). On *other* nothing is blocked. The
  status line shows `TDD on` or `TDD off (not coding)`.
- **Subagents get their own label.** A subagent (the Agent tool) is labelled
  from the brief it was spawned with, not from your last prompt: one briefed to
  implement or fix something is judged even when you asked a question or told
  the agent to delegate; one briefed to explore or review is not. While coding
  subagents run, the status line adds `· judging 1 subagent` (or `2 subagents`).
- **Blocks shell writes to source files** (`cat > file`, `>>`, `tee`, `sed -i`,
  `cp`, inline Python/Node writes) and tells the agent to use Write or Edit, so
  every change can be judged. Moving files (`mv`, `git mv`) is allowed.
- **Passes every write to a test file** without asking the model: writing a
  test is the red step itself. A test file is one in a `test/`, `tests/` or
  `__tests__/` folder (so `src/test/` too), or named `*.test.*`, `*.spec.*`,
  `*Test.java`/`.kt`, `*IT.java`/`.kt`, `test_*.py`, `*_test.py` or
  `*_test.go`.
- **Passes a write that adds exactly one test** to any other file (in-source
  tests, a Rust `#[test]` module) without asking the model.
- **Asks a second time before blocking**, and blocks only when both answers
  agree. If the judge can't be reached, the write is blocked (fail-closed).
- **Gives an identical retry the same verdict.** A write to the same file, from
  the same content to the same content, gets the verdict it got before, without
  a model call, as long as there is no new evidence: no new test run and no new
  prompt from you. After new evidence it is judged again; a retry whose verdict
  flips is logged as `verdict reversed on retry (violation → pass)` in the
  debug log.
- **Respects an explicit override.** Tell the agent *"I'm overriding the TDD
  guard for this write; let it through."* and the judge lets that write pass.

## Requirements

- Claude Code with function-hooks plugins (built and tested on 2.1.288).
- Nothing else: the mod uses the session's own model access.

## Quick start

Install it from this repository's marketplace, in Claude Code:

```
/plugin marketplace add koslowskyj/tdd-mod
/plugin install tdd-mod@tdd-mod
```

Or run it from a clone, for one session:

```sh
git clone https://github.com/koslowskyj/tdd-mod.git ~/tdd-mod
cd your-project
claude --plugin-dir ~/tdd-mod
```

Then give the agent a coding task. Each blocked write shows up as a tool error
starting with `tdd-mod:`. Every decision on a write, passes included, also
shows as a dim line in the transcript (the model does not see it), with how it
was reached and how long the write waited for it:

```
tdd-mod: pass src/cart.ts (first opinion, 2140 ms)
tdd-mod: pass src/cart.test.ts (test file, 0 ms)
tdd-mod: violation src/total.ts (second opinion, 4310 ms)
```

To see every verdict with its reason, start with `--debug` and follow the debug log:

```sh
claude --plugin-dir ~/tdd-mod --debug
tail -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/debug/latest" | grep --line-buffered "tdd-mod: "
```

Lines look like `tdd-mod: pass (first opinion) src/cart.ts — Green phase: …`,
`tdd-mod: violation (second opinion) …`, `tdd-mod: task other: …` or
`tdd-mod: subagent <agentId> task coding: …`. For every
blocked write, the full judge prompt follows in numbered parts
(`blocked prompt … part 1/3`), so the verdict can be replayed exactly.

It helps to tell the agent, in your project's `CLAUDE.md`, to work test-first
and to change files with Write and Edit only.

## Settings

Change them in `/config`, with `/plugin configure tdd-mod@tdd-mod`, or under
`pluginConfigs` in `settings.json`. Installed from the marketplace the plugin is
keyed `tdd-mod@tdd-mod`; loaded with `--plugin-dir`, `tdd-mod` (or
`tdd-mod@inline`):

```json
{
  "pluginConfigs": {
    "tdd-mod@tdd-mod": { "options": { "judgeModel": "sonnet" } }
  }
}
```

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Off, the mod does nothing. |
| `judgeModel` | `haiku` | The model that judges each write on a coding task. It writes no code; the session's own model does. Haiku is the default because it scored best in `/tdd-eval`. |
| `classifierModel` | `haiku` | The model that labels each typed prompt and each subagent's brief *coding* or *other*. |
| `classifyTasks` | `true` | Off, every task counts as coding and every write is judged. |
| `fastPath` | `true` | Pass a write that adds exactly one test without a model call. Faster, but a new test no longer checks for a refactor left unmade. |
| `secondOpinion` | `true` | Block only when a second judge call agrees. |
| `extensions` | `ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs`, `py`, `go`, `rs`, `java`, `kt`, `kts`, `scala`, `rb`, `php`, `cs`, `fs`, `swift`, `c`, `cc`, `cpp`, `h`, `hpp`, `ex`, `exs`, `erl`, `clj`, `dart`, `lua`, `ipynb`, `vue`, `svelte` | Comma-separated extensions of the files judged. |
| `ignore` | `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/vendor/**`, `**/.git/**`, `**/.claude/**` | Comma-separated globs of paths never judged. |
| `testPatterns` | *(empty: built-in patterns)* | How the fast path recognises a test declaration, per extension. A JSON object from comma-separated extensions to a regex; see below. |

A change in `/config` reloads the mod with the new values.

### Test patterns

The fast path counts test declarations with a regex per file extension. The
built-in patterns cover `it(`/`test(` in JS/TS, `def test_` in Python,
`func Test` in Go, `@Test` in Java/Kotlin, `#[test]` in Rust, `it "`/`def test_`
in Ruby and `[Fact]`/`[Test]` in C#. `testPatterns` replaces or adds patterns
per extension; an empty regex turns the fast path off for those extensions:

```json
{
  "pluginConfigs": {
    "tdd-mod@tdd-mod": {
      "options": {
        "testPatterns": "{\"ts,js\": \"\\\\bscenario\\\\(\", \"ex,exs\": \"^\\\\s*test \\\"\", \"go\": \"\"}"
      }
    }
  }
}
```

That is the JSON object `{"ts,js": "\\bscenario\\(", "ex,exs": "^\\s*test \"", "go": ""}`
written as a string. The regexes run with the `g` and `m` flags, so `^` matches
at each line. An invalid value is reported in the transcript when the session
starts, and the built-in patterns stay in place.

## Measuring the judge: `/tdd-eval`

`eval/` holds a small regression set built from kata runs and a guarded
implementation run: 23 labelled writes (`verdicts.json`) and 15 labelled
prompts (`tasks.json`). `/tdd-eval [runs]`
replays them through exactly the decisions a session makes, with the
configured models, and reports the hit rate per case:

```sh
claude -p "/tdd-eval 3" --plugin-dir ~/tdd-mod
```

Results so far, 3 runs per case:

| Judge model | Writes that should pass | Writes that should be blocked | Total |
|---|---|---|---|
| haiku (default) | 51/51 | 9/9 | 60/60 |
| opus | 51/51 | 2/9 | 53/60 |
| sonnet | 51/51 | 0/9 | 51/60 |

The classifier (haiku) labelled all 45 prompts correctly. The set is small
(three distinct violations), so treat these numbers as a direction, not a
benchmark. Add a case whenever the judge gets a real write wrong.

## Development

```sh
claude plugin validate .claude-plugin/plugin.json        # manifest and hooks, as the engine reads them
claude plugin validate .claude-plugin/marketplace.json   # the marketplace entry
claude plugin test .       # unit and hook tests (test/*.test.ts)
npx -p typescript@5 tsc -p .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code
writes when it loads the mod. Load it once (`claude --plugin-dir .`) before
type-checking.

GitHub Actions (`.github/workflows/ci.yml`) runs these checks on every push to
`main` and on pull requests, against the pinned Claude Code version. None of
them needs credentials. `/tdd-eval` is not part of CI: it calls the models.

### Releases

Every push to `main` that passes the checks is released. The release job bumps
the version in `.claude-plugin/plugin.json` from the commit messages since the
last tag, commits it, tags `vX.Y.Z` and creates a GitHub release:

| Commits since the last release | Bump |
|---|---|
| `feat!:` or `BREAKING CHANGE` | major |
| `feat:` | minor |
| anything else | patch |

Installed copies get the new version with `/plugin marketplace update tdd-mod`
(or Claude Code's marketplace auto-update). The official Anthropic marketplace
takes third-party plugins only through its
[submission form](https://clau.de/plugin-directory-submission), so that step is
manual.

| File | What it holds |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest: name, version, settings |
| `.claude-plugin/marketplace.json` | Makes this repository a marketplace that lists the plugin |
| `hooks/hooks.json` | Points Claude Code at `src/register.ts` |
| `src/register.ts` | The hooks: prompt and subagent-brief classification, the write and Bash guards, `/tdd-eval` |
| `src/guard.ts` | The two decisions: task kind, and pass/violation for a write |
| `src/prompt.ts` | The judge's TDD rules, ported from probity |
| `src/tdd.ts` | Prompt building, session history, applying an Edit, the one-new-test check |
| `src/task.ts` | The task classifier prompt and the guard-override rule |
| `src/bash.ts` | Which source files a shell command would write |
| `src/config.ts` | Settings, globs, which files are in scope |
| `src/eval.ts` | The `/tdd-eval` runner |
| `test/` | Unit and hook tests, run by `claude plugin test .` |
| `eval/` | The regression cases |

## Known limits

- **The task label holds for the whole turn.** If a "move this class" turn also
  changes behaviour, nothing judges it.
- **After a non-coding prompt, "continue" keeps the guard off.** Name the coding
  task ("now add …") to switch it back on.
- **A subagent's label holds for its whole life.** A message sent to it later
  (SendMessage, a resumed agent, a teammate's next task) does not relabel it,
  and a resumed coding subagent is judged but not counted in the status line.
- **Subagents spawned before a reload follow the main session's label.** The
  labels live in the module and start over when the mod reloads (a `/config`
  change); so do agents no Agent call started, such as a workflow's.
- **Each subagent spawn waits for one classifier call** before the subagent
  starts.
- **Shell writes are caught by pattern.** A script file that is written and then
  run, or a path built at runtime, gets through.
- **Judges disagree.** Stronger models are more lenient on the current prompt;
  see the eval table above.
- **Test files are never judged.** Adding two tests at once, or a new test while
  the last green left a refactor unmade, goes through in a test file. Fixtures
  and helpers under a test folder count as tests too. A shell write to a test
  file is still blocked and sent to Write/Edit.
- **One new test always passes**, so the check for a refactor left unmade after
  green is skipped (turn off `fastPath` to get it back).
- **Only identical retries are stable.** Two equivalent edits to sibling files
  are judged separately and can still get opposite verdicts. The verdict cache
  starts over when the mod reloads.
- **A test run is recognised by its command**: a runner's `test` subcommand
  (`npm test`, `go test`, `cargo test`, `claude plugin test`, …), a runner by
  name (`vitest`, `jest`, `pytest`, …) or a Maven/Gradle build. A project
  script (`./check_all.sh`) is not one. It counts as red when the command
  failed or its output reads like a failure (`FAIL`, `1 failed`,
  `Failures: 2`, `AssertionError`, `panicked`), green otherwise.

## Credits

The TDD rules in `src/prompt.ts` are from
[probity](https://github.com/nizos/probity) by Nizar Selander, MIT License.

## License

MIT, see [LICENSE](LICENSE).
