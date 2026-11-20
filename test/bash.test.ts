import { describe, expect, test } from 'claude-code/testing'
import { bashWriteTargets as targetsIn } from '../src/bash.ts'
import { isInScope, readConfig } from '../src/config.ts'
import { languages } from './languages.ts'

const config = readConfig({ extensions: "ts,tsx,mts,cts,js,jsx,mjs,cjs,py,go,rs,java,kt,kts,scala,rb,php,cs,fs,swift,c,cc,cpp,h,hpp,ex,exs,erl,clj,dart,lua,ipynb,vue,svelte", ignore: "**/node_modules/**,**/dist/**,**/build/**,**/vendor/**,**/.git/**,**/.claude/**,**/.local/**" })
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

  test('a heredoc written to a file is its content, not a script: paths it names are not written', () => {
    const repro = "cat > notes/repro.ts <<'EOF'\nimport { f } from '../src/bash.ts'\nopen(p, 'w')\nEOF"
    expect(bashWriteTargets(repro)).toEqual(['notes/repro.ts'])
    expect(bashWriteTargets(`tee notes/x.py <<'EOF'\nopen('src/a.py', 'w')\nEOF`)).toEqual(['notes/x.py'])
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

  test('an inline script writes only the files it opens for writing, not every path it names', () => {
    const wiki = "python3 - <<'EOF'\np='wiki/open-topics.md'\ns=open(p).read()\ns+='| D7 | coverage of `checkout/index.vue` and Cart.java |'\nopen(p,'w').write(s)\nEOF"
    expect(bashWriteTargets(wiki)).toEqual([])
    const alias = "python3 - <<'EOF'\np='src/router.ts'\ns=open(p).read()\ns=s.replace(\"import('@/views/A.vue')\", \"import('@/views/B.vue')\")\nopen(p,'w').write(s)\nEOF"
    expect(bashWriteTargets(alias)).toEqual(['src/router.ts'])
    const joined = "python3 - <<'EOF'\nD='src/accounts/'\np=D+'Lookup.java'\nopen(p,'w').write('class Lookup {} // see Other.java')\nEOF"
    expect(bashWriteTargets(joined)).toEqual(['src/accounts/Lookup.java'])
    const helper = "python3 - <<'EOF'\ndef sub(path, old, new):\n    s=open(path).read()\n    open(path,'w').write(s.replace(old,new))\nsub('src/a.ts','Old.vue','x')\nsub('src/b.vue','x','y')\nEOF"
    expect(bashWriteTargets(helper)).toEqual(['src/a.ts', 'src/b.vue'])
    // A target the script computes in a way not followed: every source path it names counts.
    const loop = "python3 - <<'EOF'\nfor p in ['src/a.ts', 'src/b.ts']:\n    open(p,'w').write('x')\nEOF"
    expect(bashWriteTargets(loop)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(bashWriteTargets("python3 - <<'EOF'\nimport json\nfor p in json.load(open('l.json')):\n    open(p,'w').write(\"import x from '@/a.vue'\")\nEOF")).toEqual([])
    const path = "python3 - <<'EOF'\nimport pathlib\np = pathlib.Path('src/a.ts'); s = p.read_text()\np.write_text(s.replace('Old.java', 'x'))\nEOF"
    expect(bashWriteTargets(path)).toEqual(['src/a.ts'])
    const globbed = "python3 - <<'EOF'\nimport pathlib\np = next(pathlib.Path('src').glob('*.ts'))\np.write_text('see src/b.ts')\nEOF"
    expect(bashWriteTargets(globbed)).toEqual(['src/*.ts'])
    // A glob that names no file type is out of reach: every source path the script names counts.
    expect(bashWriteTargets("python3 - <<'EOF'\nimport pathlib\np = next(pathlib.Path('src').glob('*'))\np.write_text(\"x = 'src/b.ts'\")\nEOF")).toEqual(['src/b.ts'])
    // A write not recognised at all is no proof the script writes nothing.
    expect(bashWriteTargets("python3 - <<'EOF'\nfrom pathlib import Path\n(Path('src') / 'a.ts').write_text('x')\nEOF")).toEqual(['a.ts'])
  })

  test('a script that edits a plan it found by a glob is no source write, whatever file names the plan quotes', () => {
    // As a subagent ran it, shortened.
    const plan =
      "cd docs/plans/checkout; python3 - <<'EOF'\nimport re,glob\ndef sub(path, start, end, new):\n    s=open(path).read()\n" +
      "    i=s.index(start); j=s.index(end)\n    s=s[:i]+new+s[j:]\n    open(path,'w').write(s)\n\np=glob.glob('6-*.md')[0]\n" +
      "sub(p,\"Backend:\\n\",\"## How\",'''fills `CreateOrUpdateDialog.vue`, `AccountDetail.vue` and 'AccountsList.vue' ''')\nEOF"
    expect(bashWriteTargets(plan)).toEqual([])
  })

  for (const [language, script] of Object.entries(languages)) {
    test(`${language}: a script writes the files it writes, found by a glob or named`, () => {
      expect(bashWriteTargets(script.docByGlob)).toEqual([])
      expect(bashWriteTargets(script.sourceByGlob)).toEqual(['src/*.ts'])
      expect(bashWriteTargets(script.named)).toEqual(['src/a.ts'])
    })
  }

  test('a path through a shell variable is read from its assignment, or left alone when unknown', () => {
    expect(bashWriteTargets("M=src/auth; sed -i 's/a/b/' $M/Credentials.java")).toEqual(['src/auth/Credentials.java'])
    expect(bashWriteTargets("export D=lib && cat > ${D}/a.ts <<'EOF'\nx\nEOF")).toEqual(['lib/a.ts'])
    expect(bashWriteTargets("mkdir -p $CLAUDE_JOB_DIR/tmp && cat > $CLAUDE_JOB_DIR/tmp/probe.py <<'EOF'\nprint(1)\nEOF")).toEqual([])
    expect(bashWriteTargets('S=/tmp/w; for t in old new; do cp x.ts $S/$t/a.ts; done')).toEqual([])
  })

  test('a > inside quotes is text, not a redirect', () => {
    expect(bashWriteTargets("sed -n 1,2p A.java; git log -L '/private Result<Integer> hide/,+12:svc/A.java'")).toEqual([])
    expect(bashWriteTargets('grep "a > b.ts" src/a.ts')).toEqual([])
    expect(bashWriteTargets('echo "a > b" > src/c.ts')).toEqual(['src/c.ts'])
    expect(bashWriteTargets('echo x > "src/a b.ts"')).toEqual(['src/a b.ts'])
  })

  test('where quoting is not clear-cut, a > inside a string does not swallow the redirect after it', () => {
    expect(bashWriteTargets('echo "<b>" > src/a.vue; echo "$(date)"')).toEqual(['src/a.vue'])
    expect(bashWriteTargets(`printf '%s' '<div>' > src/a.vue; echo '$(pwd)'`)).toEqual(['src/a.vue'])
  })

  test('where quoting is not clear-cut, a quoted redirect target is still read', () => {
    expect(bashWriteTargets(`printf 'x' > "src/a.ts" # done`)).toEqual(['src/a.ts'])
    expect(bashWriteTargets(`echo "$(date)" > 'src/a.ts'`)).toEqual(['src/a.ts'])
    expect(bashWriteTargets('echo x > "$(pwd)/src/a.ts"')).toEqual(['src/a.ts'])
  })

  test('where quoting is not clear-cut, a redirect is still read', () => {
    expect(bashWriteTargets("# don't break\necho x > src/a.ts\necho 'done'")).toEqual(['src/a.ts'])
    expect(bashWriteTargets(`v="$(grep -c "it's" README.md)"; echo 1 > src/a.ts; echo 'ok'`)).toEqual(['src/a.ts'])
    expect(bashWriteTargets('echo \\" > src/a.ts; echo "x"')).toEqual(['src/a.ts'])
  })

  test('a cd into a known variable or ~ is followed', () => {
    expect(bashWriteTargets("B=/tmp/x; cd $B/ts; sed -i 's/a/b/' rules/r.js")).toEqual(['/tmp/x/ts/rules/r.js'])
    const home = new Map([['HOME', '/home/u']])
    expect(targetsIn("cd ~/w/site && cat > src/a.ts <<'EOF'\nx\nEOF", p => isInScope(p, config), home)).toEqual(['/home/u/w/site/src/a.ts'])
  })

  test('a cd into a folder the environment names is followed; one not known keeps the write judged', () => {
    const job = new Map([['CLAUDE_JOB_DIR', '/jobs/j']])
    const inScope = (p: string) => isInScope(p, config)
    expect(targetsIn("mkdir -p $CLAUDE_JOB_DIR/tmp/demo && cd $CLAUDE_JOB_DIR/tmp/demo && cat > unpack.py <<'EOF'\nprint(1)\nEOF", inScope, job)).toEqual(['/jobs/j/tmp/demo/unpack.py'])
    expect(targetsIn("cd $CLAUDE_JOB_DIR/tmp && python3 - <<'EOF'\nopen('v.mts','w').write('x')\nEOF", inScope, job)).toEqual(['/jobs/j/tmp/v.mts'])
    // A folder not known could be the project itself: the write is still judged, from where the session is.
    expect(bashWriteTargets('cd "$PWD" && sed -i s/a/b/ src/a.ts')).toEqual(['src/a.ts'])
    expect(bashWriteTargets('cd "$(git rev-parse --show-toplevel)" && echo x > src/a.ts')).toEqual(['src/a.ts'])
    expect(bashWriteTargets('cd ~u && echo x > a.ts')).toEqual(['a.ts'])
    expect(bashWriteTargets('cd -P src && echo x > a.ts')).toEqual(['src/a.ts'])
  })

  test('a computed target with a known part is placed by that part, not by every path the script names', () => {
    const tmp = "python3 - <<'EOF'\nbase='core/x/'\nfor f in ['page_number/A.java','offset_limit/B.java']:\n    cls=f.split('/')[-1]\n    s=open(base+f).read()\n    open('/tmp/'+cls+'.new','w').write(s)\nEOF"
    expect(bashWriteTargets(tmp)).toEqual([])
    expect(bashWriteTargets(`node -e "const out=transform(src,{filename:'x#/bundle.jsx'}).code; require('fs').writeFileSync(process.env.J+'/compiled.js',out)"`)).toEqual([])
    expect(bashWriteTargets("python3 - <<'EOF'\nfor n in ['a','b']:\n    open('src/'+n+'.ts','w').write('see lib/c.ts')\nEOF")).toEqual(['src/*.ts'])
  })

  test('a computed target with several unknown parts in a row has one * for them', () => {
    expect(bashWriteTargets("python3 - <<'EOF'\nopen('src/'+a+b+c+'.ts','w').write('x')\nEOF")).toEqual(['src/*.ts'])
  })

  test('a computed target whose known parts do not settle the file type counts every source path the script names', () => {
    expect(bashWriteTargets("python3 - <<'EOF'\nfor n in ['cart.ts','order.ts']:\n    open('src/'+n,'w').write('x')\nEOF")).toEqual(['cart.ts', 'order.ts'])
    expect(bashWriteTargets("python3 - <<'EOF'\nfor d, f in [('src','a.ts')]:\n    open(d+'/'+f,'w').write('x')\nEOF")).toEqual(['a.ts'])
    expect(bashWriteTargets("python3 - <<'EOF'\np='src/a.ts'\np='src/b.ts'\nopen(p+suffix,'w').write('x')\nEOF")).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('a write target behind a command substitution, or ~ with no HOME, is still judged', () => {
    expect(bashWriteTargets(`sed -i 's/a/b/' "$(git rev-parse --show-toplevel)/src/a.ts"`)).toEqual(['src/a.ts'])
    expect(bashWriteTargets('echo x | tee "$(pwd)/src/a.ts"')).toEqual(['src/a.ts'])
    expect(bashWriteTargets('cp /tmp/a.ts `pwd`/src/a.ts')).toEqual(['src/a.ts'])
    expect(bashWriteTargets(`python3 - "$(pwd)/src/a.py" <<'EOF'\nimport sys\nopen(sys.argv[1],'w').write('x')\nEOF`)).toEqual(['src/a.py'])
    expect(bashWriteTargets('echo x > ~/p/src/a.ts')).toEqual(['~/p/src/a.ts'])
    // Only a leading command's output is a folder; one further in stands for an unknown part.
    expect(bashWriteTargets('echo x > src/$(n)/a.ts')).toEqual(['src/*/a.ts'])
    // A variable set from a command's output is a folder not known.
    expect(bashWriteTargets('ROOT=$(git rev-parse --show-toplevel)/app; cd "$ROOT" && echo x > src/a.ts')).toEqual(['src/a.ts'])
  })

  test('a computed target that starts at the working folder is judged by the rest; one under an env folder is left alone', () => {
    expect(bashWriteTargets(`node -e "require('fs').writeFileSync(process.cwd() + '/src/a.js', 'x')"`)).toEqual(['src/a.js'])
    expect(bashWriteTargets("python3 - <<'EOF'\nimport os\nROOT = os.getcwd()\nopen(ROOT + '/src/a.py','w').write('x')\nEOF")).toEqual(['src/a.py'])
    expect(bashWriteTargets(`node -e "require('fs').writeFileSync(process.env.OUT + '/a.js', 'x')"`)).toEqual([])
    // An unknown file name is no folder: the glob stays.
    expect(bashWriteTargets("python3 - <<'EOF'\nfor n in names:\n    open(n + '.py','w').write('x')\nEOF")).toEqual(['*.py'])
  })

  test('~ in a write target is read from HOME', () => {
    const home = new Map([['HOME', '/home/u']])
    expect(targetsIn('echo x > ~/p/src/a.ts', p => isInScope(p, config), home)).toEqual(['/home/u/p/src/a.ts'])
    expect(targetsIn("sed -i s/a/b/ ~/p/src/a.ts", p => isInScope(p, config), home)).toEqual(['/home/u/p/src/a.ts'])
  })

  test('a script that writes a path given on its command line writes that path', () => {
    expect(bashWriteTargets("F=src/a.vue; python3 -I - \"$F\" <<'EOF'\nimport sys,pathlib\nf=pathlib.Path(sys.argv[1]); s=f.read_text()\nf.write_text(s)\nEOF")).toEqual(['src/a.vue'])
    expect(bashWriteTargets("f=src/router/index.ts && python3 - \"$f\" <<'EOF'\nimport sys\np=sys.argv[1]\ns=open(p).read()\nopen(p,'w').write(s)\nEOF")).toEqual(['src/router/index.ts'])
    expect(bashWriteTargets("node - src/a.js <<'EOF'\nconst fs=require('fs'); const p=process.argv[2]\nfs.writeFileSync(p, 'x')\nEOF")).toEqual(['src/a.js'])
  })

  test('argv after an inline script or an option that takes a value', () => {
    // Layouts as python3 and node print them: `python3 -c code a` and `node -e code a` put a at argv[1].
    expect(bashWriteTargets(`python3 -c 'import sys; open(sys.argv[1],"w").write("x")' src/a.py`)).toEqual(['src/a.py'])
    expect(bashWriteTargets(`node -e "require('fs').writeFileSync(process.argv[1],'x')" src/a.js`)).toEqual(['src/a.js'])
    expect(bashWriteTargets("F=src/a.py; python3 -W ignore - \"$F\" <<'EOF'\nimport sys\nopen(sys.argv[1],'w').write('x')\nEOF")).toEqual(['src/a.py'])
    expect(bashWriteTargets("node -r ts-node/register - src/a.ts <<'EOF'\nrequire('fs').writeFileSync(process.argv[2],'x')\nEOF")).toEqual(['src/a.ts'])
    expect(bashWriteTargets(`node --eval "require('fs').writeFileSync(process.argv[1],'x')" src/a.js`)).toEqual(['src/a.js'])
    expect(bashWriteTargets(`python3 -Ic 'import sys; open(sys.argv[1],"w").write("x")' src/a.py`)).toEqual(['src/a.py'])
  })

  test('a scratch folder named .local is not judged by default', () => {
    expect(bashWriteTargets("cat > .local/probe/probe1.mjs <<'EOF'\nconsole.log(1)\nEOF")).toEqual([])
  })
})
