// Finds the source files a Bash command would write, so the guard can send
// those writes through Write/Edit where the TDD check judges them. A
// best-effort shell reading, not a parser: it covers the ways agents write
// files from a shell (redirects, tee, sed -i, cp, dd, inline scripts). A
// move (mv, git mv) keeps the code as it is, so it is no write here.

// `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, then the body up to the line that ends it.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
// `>`, `>>`, `>|`, `2>`, `&>` followed by a target; not `>&2` and not `->`/`=>`.
const REDIRECT = /(?:^|[^-=<>])(?:\d|&)?>[>|]?(?!&)\s*(['"]?)([^\s;|&<>'"()]+)\1/g
// Inline interpreters: Python open(..., 'w'|'a'), write_text/write_bytes, Node writeFile(Sync).
// Ruby File.write, Perl open($fh, '>', …), PHP file_put_contents and fopen, Deno and Bun writes too.
const SCRIPT_WRITE =
  /open\((?:[^()]|\([^()]*\))*['"][wax]\+?b?['"]|\.write_(?:text|bytes)\(|(?:writeFile|appendFile)(?:Sync)?\(|\b(?:File|IO|Bun)\.write\(|\bDeno\.write(?:Text)?File(?:Sync)?\(|\bfile_put_contents\(|\bopen\(\s*(?:my\s+)?\$?\w+\s*,\s*['"]\+?>/
// A path an inline script names; not an import alias such as `@/views/A.vue`.
const PATH_LITERAL = /['"`]([^'"`\s@*][^'"`\s*]*\.\w+)['"`]/g
// A command that runs a script, as `python3 -`, `/usr/bin/node -e`, `uv run python`: not `cat > f <<EOF`.
const INTERPRETER = /(?:^|\/)(?:python[\d.]*|node(?:js)?|deno|bun|tsx|ts-node|ruby|perl|php)$/
// `NAME=value`, a shell variable assignment.
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s
const VARIABLE = /\$\{?([A-Za-z_]\w*)\}?/g

/**
 * A simple command's words, where it starts in the shell text, the directory
 * a `cd` before it left (undefined: unknown), and the variables assigned before it.
 */
type Command = { words: string[]; at: number; dir: string | undefined; vars: ReadonlyMap<string, string> }

/** `path` with the shell variables `vars` knows filled in; undefined when it names one they do not. */
function expand(path: string, vars: ReadonlyMap<string, string>): string | undefined {
  let unknown = false
  const expanded = path.replace(VARIABLE, (_, name: string) => {
    const value = vars.get(name)
    if (value === undefined) unknown = true
    return value ?? ''
  })
  return unknown ? undefined : expanded
}

/** `path` as seen from `dir`, `.` and `..` folded; unchanged when it is absolute or the directory is unknown. */
function resolveIn(dir: string | undefined, path: string): string {
  if (dir === undefined || /^[/$~]/.test(path)) return path
  const parts: string[] = []
  for (const part of (dir === '' ? path : `${dir}/${path}`).split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      if (parts[parts.length - 1] !== '') parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/**
 * The simple commands of `shell` as words, split on unquoted `;`, `|`, `&`
 * and newlines, quotes removed: `sed -i 's/a;b/c/' f` stays one command.
 * Each carries the directory the `cd`s before it left, relative to where the
 * shell started ('' there), so a relative path can be read from where it runs.
 */
function commands(shell: string): Command[] {
  const result: Command[] = []
  let dir: string | undefined = ''
  let vars = new Map<string, string>()
  let words: string[] = []
  let word = ''
  let at = 0
  let quote: string | undefined
  const endWord = () => {
    if (word !== '') words.push(word)
    word = ''
  }
  const endCommand = () => {
    endWord()
    if (words[0]?.startsWith('(')) words[0] = words[0].slice(1)
    if (words.length > 0) result.push({ words, at, dir, vars })
    if (words[0] === 'cd') dir = words.length === 2 && !/^[-$~]/.test(words[1] ?? '') ? resolveIn(dir, words[1] ?? '') : undefined
    // `D=src/x` or `export D=src/x` alone sets a variable for the commands after it.
    const assigned = words[0] === 'export' ? words.slice(1) : words
    if (assigned.length > 0 && assigned.every(w => ASSIGNMENT.test(w))) {
      vars = new Map(vars)
      for (const w of assigned) {
        const [, name = '', value = ''] = ASSIGNMENT.exec(w) ?? []
        const known = expand(value, vars)
        if (known === undefined) vars.delete(name)
        else vars.set(name, known)
      }
    }
    words = []
  }
  for (let i = 0; i < shell.length; i++) {
    const c = shell[i] ?? ''
    if (words.length === 0 && word === '') at = i
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"') word += shell[++i] ?? ''
      else word += c
    } else if (c === "'" || c === '"') quote = c
    else if (c === '\\') word += shell[++i] ?? ''
    else if (c === ';' || c === '|' || c === '&' || c === '\n') endCommand()
    else if (c === ' ' || c === '\t') endWord()
    else word += c
  }
  endCommand()
  return result
}

/** The source files `command` would write that `inScope` accepts, deduplicated, in order of appearance. */
export function bashWriteTargets(command: string, inScope: (path: string) => boolean): string[] {
  const targets: string[] = []
  // The command without its heredoc bodies, and each body with where it stood.
  const heredocs: { at: number; body: string }[] = []
  let shell = ''
  let last = 0
  for (const m of command.matchAll(HEREDOC)) {
    shell += command.slice(last, m.index)
    heredocs.push({ at: shell.length, body: m[0] })
    shell += m[0].slice(0, m[0].indexOf('\n'))
    last = m.index + m[0].length
  }
  shell += command.slice(last)

  const parsed = commands(shell)
  const start: Command = { words: [], at: 0, dir: '', vars: new Map() }
  // A path as the command at `where` sees it; one through an unknown variable is left alone.
  const place = (where: Pick<Command, 'dir' | 'vars'>, path: string) => {
    const expanded = expand(path, where.vars)
    if (expanded !== undefined) targets.push(resolveIn(where.dir, expanded))
  }

  for (const m of shell.matchAll(REDIRECT)) place(parsed.findLast(c => c.at <= m.index) ?? start, m[2] ?? '')

  for (const { words: [cmd, ...args], dir, vars } of parsed) {
    const operands = args.filter(a => !a.startsWith('-'))
    const written: string[] = []
    switch (cmd) {
      case 'tee':
        written.push(...operands)
        break
      case 'sed':
      case 'perl':
        if (args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) written.push(...operands)
        break
      case 'cp':
      case 'install':
        if (operands.length > 0) written.push(operands[operands.length - 1] ?? '')
        break
      case 'dd':
        written.push(...args.filter(a => a.startsWith('of=')).map(a => a.slice(3)))
        break
    }
    for (const path of written) place({ dir, vars }, path)
  }

  // An inline script that writes files: the files it opens for writing, read
  // from where the command that runs it stands. When a target is computed in
  // a way not followed here, every source path the script names counts. A
  // heredoc fed to `cat > f` is content.
  parsed.forEach(({ words, at, dir }, i) => {
    if (!words.some(w => INTERPRETER.test(w))) return
    const end = parsed[i + 1]?.at ?? Infinity
    const script = [words.join(' '), ...heredocs.filter(h => h.at >= at && h.at < end).map(h => h.body)].join('\n')
    if (!SCRIPT_WRITE.test(script)) return
    const written = scriptTargets(script) ?? [...script.matchAll(PATH_LITERAL)].map(m => m[1] ?? '')
    targets.push(...written.map(path => resolveIn(dir, path)))
  })

  return [...new Set(targets.filter(inScope))]
}

// A call argument: anything up to the next comma, with one level of brackets (`glob('*.md')[0]`).
const ARG = String.raw`((?:[^,()]|\([^()]*\))+?)`
// Where a script writes, by the path argument: Python open(p, 'w'), Path(p).write_text(), p.write_text();
// Node writeFileSync(p, …); Deno.writeTextFile(p, …); Bun.write(p, …); Ruby File.write(p, …),
// File.open(p, 'w'); Perl open($fh, '>', p); PHP file_put_contents(p, …), fopen(p, 'w').
const WRITE_SITES = [
  new RegExp(String.raw`\bf?open\(\s*${ARG}\s*,\s*['"]\+?[wax]`, 'g'),
  new RegExp(String.raw`\bopen\(\s*(?:my\s+)?\$?\w+\s*,\s*['"]\+?>>?['"]\s*,\s*${ARG}\s*\)`, 'g'),
  new RegExp(String.raw`\bPath\(\s*${ARG}\s*\)\.write_(?:text|bytes)\(`, 'g'),
  /(?<![\w)\].$])(\w+)\.write_(?:text|bytes)\(/g,
  new RegExp(String.raw`(?:\b(?:writeFile|appendFile)(?:Sync)?|\b(?:File|IO|Bun)\.write|\bDeno\.write(?:Text)?File(?:Sync)?|\bfile_put_contents)\(\s*${ARG}\s*,`, 'g'),
]
// `name = 'a' + other`, one per statement: `const`/`let`/`my` and Perl/PHP `$name` allowed.
const SCRIPT_ASSIGNMENT = /^[ \t]*(?:(?:const|let|var|my|our|local)[ \t]+)?\$?(\w+)[ \t]*=[ \t]*([^=\n][^\n]*?)[ \t]*$/gm
const STRING = /^(['"])([^'"\n]*)\1$/
// `Path('a')` or `pathlib.Path(other)`: the path it wraps.
const PATH_OBJECT = /^(?:pathlib\.)?Path\(\s*(.+?)\s*\)$/
// A glob's pattern: Path('d').glob('p'), glob.glob('p')[0], fs.globSync, glob.sync, Deno's
// expandGlobSync, new Bun.Glob('p'), Ruby Dir.glob('p') and Dir['p'], Perl and PHP glob('p').
const GLOB = /\bPath\(\s*(['"])([^'"\n]*)\1\s*\)\.r?glob\(\s*(['"])([^'"\n]*)\3|\b(?:\w+\.)*(?:[gG]lob|globSync|iglob|sync|expandGlob(?:Sync)?)\(\s*(['"])([^'"\n]*)\5|\bDir\[\s*(['"])([^'"\n]*)\7\s*\]/
// A file type the glob names for sure: `*.md`, not `*` or `*.*`.
const TYPED = /\.\w+$/
// `def sub(path, old):`, `function sub(path, old) {`, PHP `function sub($path…`: a helper that writes its first parameter.
const HELPER = /\b(?:def|function)[ \t]+(\w+)[ \t]*\([ \t]*\$?(\w+)/g

/**
 * The values `expression` can take: a glob's pattern when it names a file
 * type, or string literals and names joined by `+`; undefined when a part is unknown.
 */
function evaluate(expression: string, names: ReadonlyMap<string, string[]>): string[] | undefined {
  const glob = GLOB.exec(expression)
  if (glob) {
    const pattern = glob[2] !== undefined ? `${glob[2]}/${glob[4]}` : (glob[6] ?? glob[8] ?? '')
    return TYPED.test(pattern) ? [pattern] : undefined
  }
  let values = ['']
  const unwrapped = PATH_OBJECT.exec(expression.trim())?.[1] ?? expression
  for (const part of unwrapped.split(/\s*\+\s*/)) {
    const literal = STRING.exec(part.trim())?.[2]
    const options = literal !== undefined ? [literal] : names.get(part.trim().replace(/^\$/, ''))
    if (options === undefined || options.length === 0) return undefined
    values = values.flatMap(v => options.map(o => v + o))
  }
  return values
}

/**
 * The files an inline script writes, from its literals, the names it assigns
 * them to, and the helpers it passes them to; undefined when one is out of reach.
 */
function scriptTargets(script: string): string[] | undefined {
  const names = new Map<string, string[]>()
  for (const [, name = '', expression = ''] of script.replaceAll(';', '\n').matchAll(SCRIPT_ASSIGNMENT)) {
    const values = evaluate(expression, names)
    if (values !== undefined) names.set(name, [...(names.get(name) ?? []), ...values])
  }
  const helpers = new Map([...script.matchAll(HELPER)].map(([, fn = '', param = '']) => [param, fn]))
  const targets: string[] = []
  for (const site of WRITE_SITES) {
    for (const [, argument = ''] of script.matchAll(site)) {
      const values = evaluate(argument, names) ?? viaHelper(argument)
      if (values === undefined) return undefined
      targets.push(...values)
    }
  }
  // The script writes (SCRIPT_WRITE said so) where no site here is recognised.
  return targets.length > 0 ? targets : undefined

  // A helper's parameter: what each call passes it.
  function viaHelper(param: string): string[] | undefined {
    const fn = helpers.get(param.replace(/^\$/, ''))
    if (fn === undefined) return undefined
    const calls = [...script.matchAll(new RegExp(String.raw`(?<!(?:def|function)[ \t]+)\b${fn}\(\s*${ARG}\s*[,)]`, 'g'))]
    const values = calls.map(([, argument = '']) => evaluate(argument, names))
    return values.length > 0 && values.every(v => v !== undefined) ? values.flat() as string[] : undefined
  }
}
