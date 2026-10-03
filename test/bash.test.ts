import { describe, expect, test } from 'claude-code/testing'
import { bashWriteTargets as targetsIn } from '../src/bash.ts'
import { isInScope, readConfig } from '../src/config.ts'

const config = readConfig({ extensions: "ts,tsx,mts,cts,js,jsx,mjs,cjs,py,go,rs,java,kt,kts,scala,rb,php,cs,fs,swift,c,cc,cpp,h,hpp,ex,exs,erl,clj,dart,lua,ipynb,vue,svelte", ignore: "**/node_modules/**,**/dist/**,**/build/**,**/vendor/**,**/.git/**,**/.claude/**" })
const bashWriteTargets = (command: string) => targetsIn(command, path => isInScope(path, config))

describe('bashWriteTargets', () => {
  test('redirects and heredocs into source files', () => {
    expect(bashWriteTargets("cat > src/a.ts <<'EOF'\nexport const f = () => 1\nEOF")).toEqual(['src/a.ts'])
    expect(bashWriteTargets('echo "x" >> src/a.test.ts && npm test')).toEqual(['src/a.test.ts'])
    expect(bashWriteTargets('printf "%s" x >| "src/b.py"')).toEqual(['src/b.py'])
  })

  test('tee, sed -i, perl -i, cp and dd', () => {
    expect(bashWriteTargets('echo x | tee -a src/a.ts')).toEqual(['src/a.ts'])
    expect(bashWriteTargets("sed -i 's/a/b/' src/a.ts src/b.ts")).toEqual(['src/a.ts', 'src/b.ts'])
    expect(bashWriteTargets("perl -pi -e 's/a/b/' lib/x.rb")).toEqual(['lib/x.rb'])
    expect(bashWriteTargets('cp /tmp/x.ts src/a.ts')).toEqual(['src/a.ts'])
    expect(bashWriteTargets('dd if=/dev/zero of=src/a.go bs=1 count=0')).toEqual(['src/a.go'])
  })

  test('sed expressions with quoted ; and | stay one command', () => {
    expect(bashWriteTargets("sed -i 's/return NaN;/return 0;/' src/a.ts && npm test")).toEqual(['src/a.ts'])
    expect(bashWriteTargets(`sed -i 's|\\.split(",")|.split(/[,\\n]/)|' src/a.ts && cat src/a.ts`)).toEqual(['src/a.ts'])
    expect(bashWriteTargets("sed -i '/if (x === \"\") return 0;/d' src/a.ts")).toEqual(['src/a.ts'])
  })

  test('inline scripts that write and name a source file', () => {
    const py = "python3 - <<'EOF'\np='src/calculator.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nEOF"
    expect(bashWriteTargets(py)).toEqual(['src/calculator.ts'])
    expect(bashWriteTargets(`node -e "require('fs').writeFileSync('src/a.js', 'x')"`)).toEqual(['src/a.js'])
  })

  test('reads, test runs and non-source targets are not writes', () => {
    expect(bashWriteTargets('npm test 2>&1 | tail -30')).toEqual([])
    expect(bashWriteTargets('cat src/a.ts && grep -n add src/a.ts')).toEqual([])
    expect(bashWriteTargets('git diff > changes.patch; echo x > /dev/null')).toEqual([])
    expect(bashWriteTargets('sed -n 1,20p src/a.ts')).toEqual([])
    expect(bashWriteTargets("python3 -c \"print(open('src/a.ts').read())\"")).toEqual([])
    expect(bashWriteTargets('cp src/a.ts /tmp/backup.txt')).toEqual([])
    expect(bashWriteTargets("cat > notes.md <<'EOF'\nconst f = (a) => a > b.ts\nEOF")).toEqual([])
    expect(bashWriteTargets('echo x > node_modules/pkg/index.js')).toEqual([])
    expect(bashWriteTargets('mv src/old.ts src/new.ts && git mv src/a.ts lib/a.ts')).toEqual([])
  })
})
