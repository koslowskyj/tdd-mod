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
- **Only on coding tasks.** Each prompt you type is labelled *coding* (adds,
  changes or fixes behaviour) or *other* (moving or renaming code, extracting,
  formatting, docs, config, questions, git). On *other* nothing is blocked. The
  status line shows `TDD on` or `TDD off (not coding)`.
- **Blocks shell writes to source files** (`cat > file`, `>>`, `tee`, `sed -i`,
  `cp`, inline Python/Node writes) and tells the agent to use Write or Edit, so
  every change can be judged. Moving files (`mv`, `git mv`) is allowed.
- **Passes a write that adds exactly one test** without asking the model:
  adding a test is the red step itself.
- **Asks a second time before blocking**, and blocks only when both answers
  agree. If the judge can't be reached, the write is blocked (fail-closed).
- **Respects an explicit override.** Tell the agent *"I'm overriding the TDD
  guard for this write; let it through."* and the judge lets that write pass.

## Requirements

- Claude Code with function-hooks plugins (built and tested on 2.1.288).
- Nothing else: the mod uses the session's own model access.

## Quick start

```sh
git clone <this repo> ~/tdd-mod
cd your-project
claude --plugin-dir ~/tdd-mod
```

Then give the agent a coding task. Each blocked write shows up as a tool error
starting with `tdd-mod:`.

To see every verdict, start with `--debug` and follow the debug log:

```sh
claude --plugin-dir ~/tdd-mod --debug
tail -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/debug/latest" | grep --line-buffered "tdd-mod: "
```

Lines look like `tdd-mod: pass (first opinion) src/cart.ts — Green phase: …`,
`tdd-mod: violation (second opinion) …` or `tdd-mod: task other: …`. For every
blocked write, the full judge prompt follows in numbered parts
(`blocked prompt … part 1/3`), so the verdict can be replayed exactly.

It helps to tell the agent, in your project's `CLAUDE.md`, to work test-first
and to change files with Write and Edit only.

## Settings

Change them in `/config`, or under `pluginConfigs` in `settings.json`. A
`--plugin-dir` plugin is keyed `tdd-mod` (or `tdd-mod@inline`):

```json
{
  "pluginConfigs": {
    "tdd-mod": { "options": { "judgeModel": "sonnet" } }
  }
}
```

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Off, the mod does nothing. |
| `judgeModel` | `haiku` | The model that judges each write on a coding task. It writes no code; the session's own model does. Haiku is the default because it scored best in `/tdd-eval`. |
| `classifierModel` | `haiku` | The model that labels each typed prompt *coding* or *other*. |
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
    "tdd-mod": {
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

`eval/` holds a small regression set built from kata runs: 20 labelled writes
(`verdicts.json`) and 15 labelled prompts (`tasks.json`). `/tdd-eval [runs]`
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
claude plugin validate .   # manifest and hooks, as the engine reads them
claude plugin test .       # unit and hook tests (hooks/*.test.ts)
npx -p typescript@5 tsc -p .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code
writes when it loads the mod. Load it once (`claude --plugin-dir .`) before
type-checking.

GitHub Actions (`.github/workflows/ci.yml`) runs the same three checks on every
push to `main` and on pull requests, against the pinned Claude Code version.
None of them needs credentials. `/tdd-eval` is not part of CI: it calls the
models.

| File | What it holds |
|---|---|
| `hooks/register.ts` | The hooks: prompt classification, the write and Bash guards, `/tdd-eval` |
| `hooks/guard.ts` | The two decisions: task kind, and pass/violation for a write |
| `hooks/prompt.ts` | The judge's TDD rules, ported from probity |
| `hooks/tdd.ts` | Prompt building, session history, applying an Edit, the one-new-test check |
| `hooks/task.ts` | The task classifier prompt and the guard-override rule |
| `hooks/bash.ts` | Which source files a shell command would write |
| `hooks/config.ts` | Settings, globs, which files are in scope |
| `hooks/eval.ts` | The `/tdd-eval` runner |
| `eval/` | The regression cases |

## Known limits

- **The task label holds for the whole turn.** If a "move this class" turn also
  changes behaviour, nothing judges it.
- **After a non-coding prompt, "continue" keeps the guard off.** Name the coding
  task ("now add …") to switch it back on.
- **Shell writes are caught by pattern.** A script file that is written and then
  run, or a path built at runtime, gets through.
- **Judges disagree.** Stronger models are more lenient on the current prompt;
  see the eval table above.
- **One new test always passes**, so the check for a refactor left unmade after
  green is skipped (turn off `fastPath` to get it back).

## Credits

The TDD rules in `hooks/prompt.ts` are from
[probity](https://github.com/nizos/probity) by Nizar Selander, MIT License.

## License

MIT, see [LICENSE](LICENSE).
