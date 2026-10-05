import type { AgentSpawnInput, ModelCompleteResult, On, SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import { buildTaskPrompt, isGuardInstruction, parseTaskKind } from '../src/task.ts'
import { globToRegExp, isInScope, isTestFile, readConfig, readTestPatterns } from '../src/config.ts'
import { addsExactlyOneTest, applyEdit, buildPrompt, evidenceOf, lastTestRun, parseVerdict, toHistory, trimHistory } from '../src/tdd.ts'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SRC = '/repo/src/cart.ts'

const FAILED_RUN: SessionMessage[] = [
  { role: 'user', text: 'add a total to the cart', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL expected 3, received 0' }],
  },
]

/** One reply for every call, or one per call in order (the last repeats). */
type World = {
  files?: Record<string, string>
  messages?: SessionMessage[]
  reply: ModelCompleteResult | ModelCompleteResult[]
  /** What the task classifier answers, one per prompt in order (the last repeats). */
  task?: string[]
}

/** Stands in for the engine: files, transcript, the validator and the tools. */
function engine(on: On, world: World) {
  const seen = { prompts: [] as string[], written: [] as string[], logs: [] as string[], transcript: [] as string[], classified: [] as string[], status: [] as (string | undefined)[] }
  const replies = Array.isArray(world.reply) ? world.reply : [world.reply]
  const files = world.files ?? {}
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    if (e.to === 'transcript') seen.transcript.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.messages', () => ({ value: world.messages ?? FAILED_RUN }))
  on('model.complete', ($, e) => {
    if (e.prompt.startsWith('Classify a request')) {
      seen.classified.push(e.prompt)
      const tasks = world.task ?? ['coding']
      return { value: answer(tasks[Math.min(seen.classified.length, tasks.length) - 1] ?? 'coding') }
    }
    seen.prompts.push(e.prompt)
    return { value: replies[Math.min(seen.prompts.length, replies.length) - 1] as ModelCompleteResult }
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    seen.written.push(e.file_path)
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    seen.written.push(e.file_path)
    return { result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `agent-${++spawned}` }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return seen
}

const answer = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })

describe('tool.call', () => {
  test('a write the validator passes goes through', async ($, on) => {
    const seen = engine(on, { reply: answer('{"kind":"pass","reason":""}') })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'export const total = () => 3' })
    expect(r.deny).toBeUndefined()
    expect(seen.written).toEqual([SRC])
  })

  test('a violation blocks the write and tells the agent why', async ($, on) => {
    const seen = engine(on, { reply: answer('{"kind":"violation","reason":"no failing test observed"}') })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'export const total = () => 3' })
    expect(r.deny).toBe('tdd-mod: no failing test observed')
    expect(seen.written).toEqual([])
  })

  test('a pass needs no second opinion', async ($, on) => {
    const seen = engine(on, { reply: answer('{"kind":"pass","reason":""}') })
    await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(seen.prompts.length).toBe(1)
  })

  test('a violation the second opinion overturns goes through', async ($, on) => {
    const seen = engine(on, {
      reply: [answer('{"kind":"violation","reason":"misfire"}'), answer('{"kind":"pass","reason":""}')],
    })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(r.deny).toBeUndefined()
    expect(seen.prompts.length).toBe(2)
    expect(seen.prompts[1]).toBe(seen.prompts[0])
    expect(seen.written).toEqual([SRC])
  })

  test('a block reports the second opinion and logs the prompt for replay', async ($, on) => {
    const seen = engine(on, {
      reply: [answer('{"kind":"violation","reason":"first"}'), answer('{"kind":"violation","reason":"second"}')],
    })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(r.deny).toBe('tdd-mod: second')
    const parts = seen.logs.filter(l => l.includes('blocked prompt'))
    expect(parts.every(l => l.length <= 4096)).toBe(true)
    expect(parts.map(l => l.slice(l.indexOf(':\n') + 2)).join('')).toBe(seen.prompts[0])
  })

  // Tests written inside a source file (in-source tests) go through the fast path.
  test('adding one test passes without asking the validator', async ($, on) => {
    const TEST = SRC
    const seen = engine(on, {
      files: { [TEST]: 'test("a", () => {})\n' },
      reply: answer('{"kind":"violation","reason":"never asked"}'),
    })
    const r = await $.tool.call({ tool: 'Edit', file_path: TEST, old_string: '{})\n', new_string: '{})\ntest("b", () => {})\n' })
    expect(r.deny).toBeUndefined()
    expect(seen.prompts).toEqual([])
    expect(seen.logs.some(l => l.includes('fast path'))).toBe(true)
  })

  test('a custom test pattern drives the fast path', { options: { testPatterns: '{"ts": "\\\\bscenario\\\\("}' } }, async ($, on) => {
    const TEST = SRC
    const seen = engine(on, { reply: answer('{"kind":"violation","reason":"asked"}') })
    const one = await $.tool.call({ tool: 'Write', file_path: TEST, content: 'scenario("adds", () => {})\n' })
    expect(one.deny).toBeUndefined()
    expect(seen.prompts).toEqual([])
    const builtIn = await $.tool.call({ tool: 'Write', file_path: TEST, content: 'test("adds", () => {})\n' })
    expect(builtIn.deny).toBe('tdd-mod: asked')
  })

  test('adding two tests at once goes to the validator', async ($, on) => {
    const TEST = SRC
    const seen = engine(on, { reply: answer('{"kind":"violation","reason":"one test at a time"}') })
    const r = await $.tool.call({ tool: 'Write', file_path: TEST, content: 'test("a", () => {})\ntest("b", () => {})\n' })
    expect(r.deny).toBe('tdd-mod: one test at a time')
    expect(seen.prompts.length).toBe(2)
  })

  test('a Bash command that writes a source file is sent to Write/Edit', async ($, on) => {
    const seen = engine(on, { reply: answer('{"kind":"pass","reason":"never asked"}') })
    const r = await $.tool.call({ tool: 'Bash', command: "cat > src/cart.ts <<'EOF'\nexport const total = () => 3\nEOF" })
    expect(r.deny).toContain('src/cart.ts')
    expect(r.deny).toContain('Write or Edit')
    expect(seen.prompts).toEqual([])
  })

  test('other Bash commands run', async ($, on) => {
    engine(on, { reply: answer('{"kind":"pass","reason":""}') })
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -30' })
    expect(r.deny).toBeUndefined()
  })

  test('a pass logs its reason', async ($, on) => {
    const seen = engine(on, { reply: answer('{"kind":"pass","reason":"green: minimum to pass the failing test"}') })
    await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(seen.logs.some(l => l.includes('pass (first opinion)') && l.includes('green: minimum'))).toBe(true)
  })

  test('every decision shows in the transcript with how it was reached and its latency', async ($, on) => {
    const seen = engine(on, { reply: [answer('{"kind":"pass","reason":"green"}'), answer('{"kind":"violation","reason":"r"}')] })
    await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/cart.test.ts', content: 'x' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/total.ts', content: 'y' })
    expect(seen.transcript.map(l => l.replace(/\d+ ms/, 'N ms'))).toEqual([
      `tdd-mod: pass ${SRC} (first opinion, N ms)`,
      'tdd-mod: pass /repo/src/cart.test.ts (test file, N ms)',
      'tdd-mod: violation /repo/src/total.ts (second opinion, N ms)',
    ])
  })

  test('an identical retry with nothing new in the session gets the same verdict without a model call', async ($, on) => {
    const seen = engine(on, { reply: [answer('{"kind":"violation","reason":"no failing test"}'), answer('{"kind":"violation","reason":"no failing test"}'), answer('{"kind":"pass","reason":""}')] })
    const first = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    const retry = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(retry.deny).toBe(first.deny)
    expect(seen.prompts.length).toBe(2)
    expect(seen.transcript.at(-1)?.replace(/\d+ ms/, 'N ms')).toBe(`tdd-mod: violation ${SRC} (cached, N ms)`)
  })

  test('a retry after a new test run is judged again, and a reversed verdict is logged', async ($, on) => {
    const world: World = { messages: FAILED_RUN, reply: [answer('{"kind":"violation","reason":"no failing test"}'), answer('{"kind":"violation","reason":"no failing test"}'), answer('{"kind":"pass","reason":"green"}')] }
    const seen = engine(on, world)
    await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    const rerun = { tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL expected 4, received 0' }
    world.messages = [...FAILED_RUN, { role: 'assistant', text: '', toolUses: [rerun] }]
    const retry = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(retry.deny).toBeUndefined()
    expect(seen.logs).toContain(`tdd-mod: verdict reversed on retry (violation → pass) ${SRC}`)
  })

  test('fails closed when the validator does not answer', async ($, on) => {
    const seen = engine(on, { reply: { isAnswered: false, reason: 'empty-reply', usage: USAGE } })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(r.deny).toContain('empty-reply')
    expect(seen.written).toEqual([])
  })

  test('fails closed on an unparseable verdict', async ($, on) => {
    const seen = engine(on, { reply: answer('looks fine to me') })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(r.deny).toContain('could not parse verdict')
    expect(seen.written).toEqual([])
  })

  test('a write or edit to a test file passes without the validator', async ($, on) => {
    const TEST = '/repo/src/cart.test.ts'
    const seen = engine(on, { files: { [TEST]: 'x' }, reply: answer('{"kind":"violation","reason":"never asked"}') })
    const w = await $.tool.call({ tool: 'Write', file_path: TEST, content: 'x' })
    const e = await $.tool.call({ tool: 'Edit', file_path: TEST, old_string: 'x', new_string: 'y' })
    expect(w.deny).toBeUndefined()
    expect(e.deny).toBeUndefined()
    expect(seen.prompts).toEqual([])
  })

  test('files out of scope skip the validator', async ($, on) => {
    const seen = engine(on, { reply: answer('{"kind":"violation","reason":"never asked"}') })
    await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: '# hi' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/node_modules/x/index.js', content: '' })
    expect(seen.prompts).toEqual([])
    expect(seen.written).toEqual(['/repo/README.md', '/repo/node_modules/x/index.js'])
  })

  test('an Edit is judged as the whole file it leaves, with history and the current file', async ($, on) => {
    const seen = engine(on, {
      files: { [SRC]: 'export const total = () => 0\n' },
      reply: answer('{"kind":"pass","reason":""}'),
    })
    await $.tool.call({ tool: 'Edit', file_path: SRC, old_string: '=> 0', new_string: '=> 3' })
    const prompt = seen.prompts[0] ?? ''
    expect(prompt).toContain('## Current file content\n\nexport const total = () => 0')
    expect(prompt).toContain(`File: ${SRC}\n\nexport const total = () => 3`)
    expect(prompt).toContain('User: add a total to the cart')
    expect(prompt).toContain('Bash({"command":"npm test"}) → FAIL expected 3, received 0')
  })

  test('the validator sees the last test run, red or green, beyond the recent window', async ($, on) => {
    const reads: SessionMessage = {
      role: 'assistant',
      text: '',
      toolUses: Array.from({ length: 12 }, (_, i) => ({ tool_use_id: `r${i}`, tool: 'Read', input: { file_path: `/repo/f${i}.ts` }, text: '' })),
    }
    const seen = engine(on, { messages: [...FAILED_RUN, reads], reply: answer('{"kind":"pass","reason":""}') })
    await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(seen.prompts[0]).toContain('## Last test run\n\n`npm test` was red: a test failed. Its output:\n\nFAIL expected 3, received 0')
    expect(seen.prompts[0]).not.toContain('npm test"}) →')
    expect(seen.prompts[0]).toContain('4. "Last test run"')
  })

  test('a new file is shown to the validator as absent', async ($, on) => {
    const seen = engine(on, { reply: answer('{"kind":"pass","reason":""}') })
    await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(seen.prompts[0]).toContain('(file does not exist)')
  })
})

const typed = { wait: false, origin: { kind: 'composer' } } as const

describe('task kind', () => {
  test('writes are judged while the task is coding', async ($, on) => {
    const seen = engine(on, { task: ['coding'], reply: answer('{"kind":"violation","reason":"no failing test"}') })
    await $.prompt.submit({ ...typed, text: 'add a total to the cart' })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(r.deny).toBe('tdd-mod: no failing test')
    expect(seen.status.at(-1)).toBe('TDD on')
  })

  test('nothing is blocked while the task is other', async ($, on) => {
    const seen = engine(on, { task: ['other'], reply: answer('{"kind":"violation","reason":"never asked"}') })
    await $.prompt.submit({ ...typed, text: 'move the Cart class to src/model/cart.ts' })
    const w = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    const b = await $.tool.call({ tool: 'Bash', command: "cat > src/model/cart.ts <<'EOF'\nx\nEOF" })
    expect(w.deny).toBeUndefined()
    expect(b.deny).toBeUndefined()
    expect(seen.prompts).toEqual([])
    expect(seen.status.at(-1)).toBe('TDD off (not coding)')
  })

  test('the guard is back on with the next coding prompt', async ($, on) => {
    const seen = engine(on, { task: ['other', 'coding'], reply: answer('{"kind":"violation","reason":"no failing test"}') })
    await $.prompt.submit({ ...typed, text: 'rename add to sum' })
    await $.prompt.submit({ ...typed, text: 'now support negative numbers' })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(r.deny).toBe('tdd-mod: no failing test')
    expect(seen.classified[1]).toContain('The previous request was labelled other')
  })

  test('overriding the guard keeps the task as it is', async ($, on) => {
    const seen = engine(on, { task: ['coding', 'other'], reply: answer('{"kind":"violation","reason":"no failing test"}') })
    await $.prompt.submit({ ...typed, text: 'do step 1' })
    await $.prompt.submit({ ...typed, text: "I'm overriding the TDD guard for this write; let it through." })
    expect(seen.classified.length).toBe(1)
    expect(seen.status.at(-1)).toBe('TDD on')
  })

  test('an unclear classifier answer keeps the guard on', async ($, on) => {
    engine(on, { task: ['hmm'], reply: answer('{"kind":"violation","reason":"no failing test"}') })
    await $.prompt.submit({ ...typed, text: 'do the thing' })
    const r = await $.tool.call({ tool: 'Write', file_path: SRC, content: 'x' })
    expect(r.deny).toBe('tdd-mod: no failing test')
  })
})

/** What the Agent tool hands `agent.spawn` for a subagent briefed with `prompt`. */
const brief = (prompt: string): AgentSpawnInput => ({
  tool_use_id: 'toolu_spawn',
  prompt,
  description: 'subagent',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'opus',
  background: true,
  fork: false,
})

/** A tool call from the subagent's loop; the test engine carries `agentId` through, though its type leaves it out. */
const inAgent = <const T extends object>(agentId: string | undefined, args: T): T => ({ ...args, agentId })

describe('subagents', () => {
  test('a subagent briefed to code is judged while the main task is other', async ($, on) => {
    engine(on, { task: ['other', 'coding'], reply: answer('{"kind":"violation","reason":"no failing test"}') })
    await $.prompt.submit({ ...typed, text: 'spawn an agent that implements the cart total test-first' })
    const { agentId } = await $.agent.spawn(brief('Implement the cart total test-first.'))
    const r = await $.tool.call(inAgent(agentId, { tool: 'Write', file_path: SRC, content: 'x' }))
    expect(r.deny).toBe('tdd-mod: no failing test')
  })

  test('a subagent briefed to explore is not judged while the main task is coding', async ($, on) => {
    const seen = engine(on, { task: ['coding', 'other'], reply: answer('{"kind":"violation","reason":"never asked"}') })
    await $.prompt.submit({ ...typed, text: 'add a total to the cart' })
    const { agentId } = await $.agent.spawn(brief('Find where the cart is priced and report the files.'))
    const r = await $.tool.call(inAgent(agentId, { tool: 'Write', file_path: SRC, content: 'x' }))
    expect(r.deny).toBeUndefined()
    expect(seen.prompts).toEqual([])
  })

  test('with classifyTasks off a subagent is judged without a classifier call', { options: { classifyTasks: false } }, async ($, on) => {
    const seen = engine(on, { task: ['other'], reply: answer('{"kind":"violation","reason":"no failing test"}') })
    const { agentId } = await $.agent.spawn(brief('Find where the cart is priced and report the files.'))
    const r = await $.tool.call(inAgent(agentId, { tool: 'Write', file_path: SRC, content: 'x' }))
    expect(r.deny).toBe('tdd-mod: no failing test')
    expect(seen.classified).toEqual([])
  })

  test('the status line counts the subagents being judged', async ($, on) => {
    const seen = engine(on, { task: ['other', 'coding', 'other'], reply: answer('{"kind":"pass","reason":""}') })
    await $.prompt.submit({ ...typed, text: 'spawn an agent that implements the cart total test-first' })
    await $.agent.spawn(brief('Implement the cart total test-first.'))
    await $.agent.spawn(brief('Review the diff.'))
    expect(seen.status.at(-1)).toBe('TDD off (not coding) · judging 1 subagent')
  })

  test('a subagent whose run ended leaves the status line', async ($, on) => {
    const seen = engine(on, { task: ['other', 'coding'], reply: answer('{"kind":"pass","reason":""}') })
    await $.prompt.submit({ ...typed, text: 'spawn an agent that implements the cart total test-first' })
    const { agentId } = await $.agent.spawn(brief('Implement the cart total test-first.'))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId, reason: 'answer' })
    expect(seen.status.at(-1)).toBe('TDD off (not coding)')
  })

  test("a subagent's label goes to the debug log", async ($, on) => {
    const seen = engine(on, { task: ['coding'], reply: answer('{"kind":"pass","reason":""}') })
    await $.agent.spawn(brief('Implement the cart\ntotal test-first.'))
    expect(seen.logs).toContain('tdd-mod: subagent agent-1 task coding: Implement the cart total test-first.')
  })

  test('a subagent resumed after its run ended is still judged by its brief', async ($, on) => {
    engine(on, { task: ['other', 'coding'], reply: answer('{"kind":"violation","reason":"no failing test"}') })
    await $.prompt.submit({ ...typed, text: 'spawn an agent that implements the cart total test-first' })
    const { agentId } = await $.agent.spawn(brief('Implement the cart total test-first.'))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId, reason: 'answer' })
    const r = await $.tool.call(inAgent(agentId, { tool: 'Write', file_path: SRC, content: 'x' }))
    expect(r.deny).toBe('tdd-mod: no failing test')
  })
})

describe('tdd logic', () => {
  test('addsExactlyOneTest counts test declarations per language', () => {
    const absent = { kind: 'absent' } as const
    const present = (content: string) => ({ kind: 'present', content }) as const
    expect(addsExactlyOneTest('a.test.ts', absent, 'it("x", () => {})')).toBe(true)
    expect(addsExactlyOneTest('a.test.ts', present('test("x", f)'), 'test("x", f)\ntest.only(`y`, f)')).toBe(true)
    expect(addsExactlyOneTest('a.test.ts', present('test("x", f)'), 'test("x", f)')).toBe(false)
    expect(addsExactlyOneTest('a.test.ts', absent, 'test("x", f)\ntest("y", f)')).toBe(false)
    expect(addsExactlyOneTest('test_a.py', absent, 'def test_x():\n    pass')).toBe(true)
    expect(addsExactlyOneTest('a_test.go', absent, 'func TestX(t *testing.T) {}')).toBe(true)
    expect(addsExactlyOneTest('ATest.java', absent, '@Test\nvoid x() {}')).toBe(true)
    expect(addsExactlyOneTest('a.test.ts', { kind: 'unknown' }, 'test("x", f)')).toBe(false)
    expect(addsExactlyOneTest('a.md', absent, 'test("x", f)')).toBe(false)
  })

  test('parseTaskKind reads the label and defaults to coding', () => {
    expect(parseTaskKind('other')).toBe('other')
    expect(parseTaskKind('Label: Other.')).toBe('other')
    expect(parseTaskKind('coding')).toBe('coding')
    expect(parseTaskKind('')).toBe('coding')
    expect(buildTaskPrompt('continue', 'coding')).toContain('the previous label: coding')
    expect(isGuardInstruction("I'm overriding the TDD guard; let it through")).toBe(true)
    expect(isGuardInstruction('let the stub through')).toBe(true)
    expect(isGuardInstruction('move the Cart class to src/model')).toBe(false)
    expect(isGuardInstruction('add support for negative numbers')).toBe(false)
  })

  test('parseVerdict reads fenced and embedded JSON', () => {
    expect(parseVerdict('```json\n{"kind":"pass","reason":""}\n```')).toEqual({ kind: 'pass', reason: '' })
    expect(parseVerdict('Thinking... {"kind":"violation","reason":"r"}')).toEqual({ kind: 'violation', reason: 'r' })
    expect(parseVerdict('{"kind":"maybe","reason":""}').kind).toBe('violation')
  })

  test('applyEdit follows the Edit contract', () => {
    expect(applyEdit('a b a', 'b', '$&')).toBe('a $& a')
    expect(applyEdit('a b a', 'a', 'c')).toBeUndefined()
    expect(applyEdit('a b a', 'a', 'c', true)).toBe('c b c')
    expect(applyEdit('a', 'z', 'c')).toBeUndefined()
  })

  test('isInScope takes listed extensions outside ignored paths', () => {
    const config = readConfig({ extensions: 'ts, .py', ignore: '**/dist/**,src/gen/*.ts' })
    expect(isInScope('/r/src/a.test.ts', config)).toBe(true)
    expect(isInScope('/r/app/main.py', config)).toBe(true)
    expect(isInScope('/r/package.json', config)).toBe(false)
    expect(isInScope('/r/main.go', config)).toBe(false)
    expect(isInScope('/r/dist/a.ts', config)).toBe(false)
    expect(isInScope('src/gen/api.ts', config)).toBe(false)
  })

  test('isTestFile knows test folders and test file names', () => {
    const tests = [
      '/r/test/register.ts', 'test/a.py', '/r/tests/a.rs', '/r/service/src/test/java/a/Helper.java',
      '/r/src/__tests__/a.js', '/r/src/a.test.ts', '/r/src/a.spec.tsx', '/r/a/CartTest.java', '/r/a/CartIT.java',
      '/r/a/CartTest.kt', '/r/app/test_cart.py', '/r/app/cart_test.py', '/r/pkg/cart_test.go',
    ]
    const sources = ['/r/src/cart.ts', '/r/src/testing.ts', '/r/src/contest/a.ts', '/r/a/Latest.java', '/r/a/Cartest.java', '/r/attest.py', '/r/src/protest_x.py']
    expect(tests.filter(p => !isTestFile(p))).toEqual([])
    expect(sources.filter(isTestFile)).toEqual([])
  })

  test('readTestPatterns overrides, extends and removes per extension', () => {
    const { patterns, problems } = readTestPatterns('{"ts, .js": "\\\\bscenario\\\\(", "ex": "^\\\\s*test \\"", "go": ""}')
    expect(problems).toEqual([])
    expect(addsExactlyOneTest('a.ts', { kind: 'absent' }, 'scenario(1)', patterns)).toBe(true)
    expect(addsExactlyOneTest('a.ts', { kind: 'absent' }, 'test("x", f)', patterns)).toBe(false)
    expect(addsExactlyOneTest('a.js', { kind: 'absent' }, 'scenario(1)', patterns)).toBe(true)
    expect(addsExactlyOneTest('a.ex', { kind: 'absent' }, '  test "adds" do', patterns)).toBe(true)
    expect(addsExactlyOneTest('a_test.go', { kind: 'absent' }, 'func TestX(t *testing.T) {}', patterns)).toBe(false)
    expect(addsExactlyOneTest('test_a.py', { kind: 'absent' }, 'def test_x(): pass', patterns)).toBe(true)
  })

  test('readTestPatterns reports bad values and keeps the built-ins', () => {
    expect(readTestPatterns('').problems).toEqual([])
    expect(readTestPatterns('{nope').problems[0]).toContain('not valid JSON')
    expect(readTestPatterns('["ts"]').problems[0]).toContain('must be a JSON object')
    const bad = readTestPatterns('{"ts": "("}')
    expect(bad.problems[0]).toContain('not a valid regex')
    expect(addsExactlyOneTest('a.ts', { kind: 'absent' }, 'test("x", f)', bad.patterns)).toBe(true)
  })

  test('globToRegExp', () => {
    expect(globToRegExp('**/node_modules/**').test('/r/node_modules/x/y.js')).toBe(true)
    expect(globToRegExp('**/node_modules/**').test('/r/src/y.js')).toBe(false)
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false)
  })

  test('readConfig falls back to the defaults', () => {
    const config = readConfig({})
    expect(config.judgeModel).toBe('haiku')
    expect(config.classifierModel).toBe('haiku')
    expect(config.enabled && config.classifyTasks && config.fastPath && config.secondOpinion).toBe(true)
  })

  test('history keeps answered tool calls and clips long output', () => {
    const history = toHistory([
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'p', tool: 'Write', input: {} }] },
      ...FAILED_RUN,
    ])
    expect(history.map(e => e.kind)).toEqual(['prompt', 'tool'])
    const errored = toHistory([{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Bash', input: {}, text: 'Exit code 1', isError: true }] }])
    expect(errored).toEqual([{ kind: 'tool', tool: 'Bash', input: {}, output: 'Exit code 1', isError: true }])
    const [clipped] = trimHistory([{ kind: 'prompt', text: 'x'.repeat(100) }], 10, 20)
    expect(clipped).toEqual({ kind: 'prompt', text: `${'x'.repeat(10)}\n[80 more characters truncated]\n${'x'.repeat(10)}` })
  })

  test('lastTestRun finds the latest test command and reads red or green', () => {
    const run = (command: string, output: string, isError?: true) => ({ kind: 'tool', tool: 'Bash', input: { command }, output, ...(isError && { isError }) }) as const
    const passing = run('npm test 2>&1 | tail -30', ' 12 pass\n 0 fail')
    expect(lastTestRun([passing, run('ls test/', 'a.test.ts')])).toEqual({ command: 'npm test 2>&1 | tail -30', output: ' 12 pass\n 0 fail', red: false })
    expect(lastTestRun([run('npx vitest run', 'Exit code 1\nFAIL src/a.test.ts', true), { kind: 'prompt', text: 'go on' }])?.red).toBe(true)
    expect(lastTestRun([passing, run('npm test | tail', '(fail) adds\n 11 pass\n 1 fail')])?.red).toBe(true)
    const red = (command: string, output: string) => lastTestRun([run(command, output)])?.red
    expect(red('./mvnw -q test -Dtest=CartIT', 'Tests run: 3, Failures: 1, Errors: 0')).toBe(true)
    expect(red('mvn verify', 'Tests run: 3, Failures: 0, Errors: 0\nBUILD SUCCESS')).toBe(false)
    expect(red('python -m pytest -q', '1 failed, 3 passed')).toBe(true)
    expect(red('go test ./...', 'ok  \tcart\t0.01s')).toBe(false)
    expect(red('cargo test', "thread 'adds' panicked at src/lib.rs:3")).toBe(true)
    expect(red('claude plugin test .', ' 47 pass\n 0 fail')).toBe(false)
    expect(red('npm test 2>&1 | tail -30', 'not ok 1 - src/a.test.ts\n# pass 0\n# fail 1')).toBe(true)
    expect(red('npm test 2>&1 | tail -30', 'ok 1 - src/a.test.ts\n# pass 1\n# fail 0')).toBe(false)
    expect(lastTestRun([run('git status', ''), run('cat test/a.ts', 'FAIL')])).toBeUndefined()
  })

  test('evidenceOf changes with a new test run or prompt, not with other tool calls', () => {
    const base = toHistory(FAILED_RUN)
    const read = { kind: 'tool', tool: 'Read', input: {}, output: 'x' } as const
    expect(evidenceOf([...base, read])).toBe(evidenceOf(base))
    expect(evidenceOf([...base, { kind: 'prompt', text: 'let it through' }])).not.toBe(evidenceOf(base))
    expect(evidenceOf([...base, { kind: 'tool', tool: 'Bash', input: { command: 'npm test' }, output: 'ok' }])).not.toBe(evidenceOf(base))
  })

  test('after a green run the prompt lets behaviour-preserving changes pass', () => {
    const after = (output: string) =>
      buildPrompt([{ kind: 'tool', tool: 'Bash', input: { command: 'npm test' }, output }], { kind: 'unknown' }, { path: 'a.ts', content: 'x' })
    const REFACTOR = 'The tests are green, so this may be the refactor step'
    expect(after(' 3 pass\n 0 fail')).toContain(REFACTOR)
    expect(after('FAIL a.test.ts')).not.toContain(REFACTOR)
  })

  test('the prompt leaves out an empty history', () => {
    const prompt = buildPrompt([], { kind: 'unknown' }, { path: 'a.ts', content: 'x' })
    expect(prompt).not.toContain('## Recent session')
    expect(prompt).toContain('(current file content unavailable)')
  })
})
