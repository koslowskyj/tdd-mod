// Inline scripts in each language the shell guard reads, shared by
// bash.test.ts and a run against the real interpreters.
// Every interpreter whose inline scripts are read, the same three cases in each:
// a doc found by a glob, a source file found by a glob, and a source file by name.
// The doc's content quotes a source file name; the named write's content does too.
export const languages: Record<string, { docByGlob: string; sourceByGlob: string; named: string }> = {
  python: {
    docByGlob: "python3 - <<'EOF'\nimport glob\np = glob.glob('wiki/6-*.md')[0]\nopen(p, 'w').write(open(p).read() + 'A.vue')\nEOF",
    sourceByGlob: "python3 - <<'EOF'\nimport glob\nfirst = sorted(glob.glob('src/*.ts'))[0]\nwith open(first, 'w') as f:\n    f.write('x')\nEOF",
    named: "python3 -c \"open('src/a.ts', 'w').write('B.vue')\"",
  },
  node: {
    docByGlob: "node <<'EOF'\nconst fs = require('fs')\nconst p = fs.globSync('wiki/6-*.md')[0]\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8') + 'A.vue')\nEOF",
    sourceByGlob: "node <<'EOF'\nconst { globSync, appendFileSync } = require('fs')\nconst p = globSync('src/*.ts')[0]\nappendFileSync(p, 'x')\nEOF",
    named: "node -e \"require('fs').writeFileSync('src/a.ts', 'B.vue')\"",
  },
  deno: {
    docByGlob: "deno run -A - <<'EOF'\nimport { expandGlobSync } from 'jsr:@std/fs'\nconst p = [...expandGlobSync('wiki/6-*.md')][0].path\nDeno.writeTextFileSync(p, Deno.readTextFileSync(p) + 'A.vue')\nEOF",
    sourceByGlob: "deno run -A - <<'EOF'\nimport { expandGlobSync } from 'jsr:@std/fs'\nconst p = [...expandGlobSync('src/*.ts')][0].path\nDeno.writeTextFileSync(p, 'x')\nEOF",
    named: "deno eval \"Deno.writeTextFileSync('src/a.ts', 'B.vue')\"",
  },
  bun: {
    docByGlob: "bun - <<'EOF'\nconst p = [...new Bun.Glob('wiki/6-*.md').scanSync('.')][0]\nawait Bun.write(p, 'A.vue')\nEOF",
    sourceByGlob: "bun - <<'EOF'\nconst p = [...new Bun.Glob('src/*.ts').scanSync('.')][0]\nawait Bun.write(p, 'x')\nEOF",
    named: "bun -e \"await Bun.write('src/a.ts', 'B.vue')\"",
  },
  ruby: {
    docByGlob: "ruby - <<'EOF'\np = Dir.glob('wiki/6-*.md').first\nFile.write(p, File.read(p) + 'A.vue')\nEOF",
    sourceByGlob: "ruby - <<'EOF'\np = Dir['src/*.ts'][0]\nFile.open(p, 'w') { |f| f.write('x') }\nEOF",
    named: "ruby -e \"File.write('src/a.ts', 'B.vue')\"",
  },
  perl: {
    docByGlob: "perl - <<'EOF'\nmy $p = (glob('wiki/6-*.md'))[0];\nopen(my $fh, '>>', $p) or die;\nprint $fh 'A.vue';\nEOF",
    sourceByGlob: "perl - <<'EOF'\nmy $p = (glob('src/*.ts'))[0];\nopen(my $fh, '>', $p) or die;\nprint $fh 'x';\nEOF",
    named: "perl -e \"open(my \\$fh, '>', 'src/a.ts') or die; print \\$fh 'B.vue'\"",
  },
  php: {
    docByGlob: "php <<'EOF'\n<?php\n$p = glob('wiki/6-*.md')[0];\nfile_put_contents($p, file_get_contents($p) . 'A.vue');\nEOF",
    sourceByGlob: "php <<'EOF'\n<?php\n$f = fopen(glob('src/*.ts')[0], 'w');\nfwrite($f, 'x');\nEOF",
    named: "php -r \"file_put_contents('src/a.ts', 'B.vue');\"",
  },
}
