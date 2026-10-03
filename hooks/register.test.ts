import type { ModelCompleteResult, On, SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import { buildTaskPrompt, isGuardInstruction, parseTaskKind } from './task.ts'
import { globToRegExp, isInScope, readConfig } from './config.ts'
import { addsExactlyOneTest, applyEdit, buildPrompt, parseVerdict, toHistory, trimHistory } from './tdd.ts'

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
  const seen = { prompts: [] as string[], written: [] as string[], logs: [] as string[], classified: [] as string[], status: [] as (string | undefined)[] }
  const replies = Array.isArray(world.reply) ? world.reply : [world.reply]
  const files = world.files ?? {}
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
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

  test('adding one test passes without asking the validator', async ($, on) => {
    const TEST = '/repo/src/cart.test.ts'
    const seen = engine(on, {
      files: { [TEST]: 'test("a", () => {})\n' },
      reply: answer('{"kind":"violation","reason":"never asked"}'),
    })
    const r = await $.tool.call({ tool: 'Edit', file_path: TEST, old_string: '{})\n', new_string: '{})\ntest("b", () => {})\n' })
    expect(r.deny).toBeUndefined()
    expect(seen.prompts).toEqual([])
    expect(seen.logs.some(l => l.includes('fast path'))).toBe(true)
  })

  test('adding two tests at once goes to the validator', async ($, on) => {
    const TEST = '/repo/src/cart.test.ts'
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
    const [clipped] = trimHistory([{ kind: 'prompt', text: 'x'.repeat(100) }], 10, 20)
    expect(clipped).toEqual({ kind: 'prompt', text: `${'x'.repeat(10)}\n[80 more characters truncated]\n${'x'.repeat(10)}` })
  })

  test('the prompt leaves out an empty history', () => {
    const prompt = buildPrompt([], { kind: 'unknown' }, { path: 'a.ts', content: 'x' })
    expect(prompt).not.toContain('## Recent session')
    expect(prompt).toContain('(current file content unavailable)')
  })
})
