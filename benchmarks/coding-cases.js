// Author-curated mutations in real production source. Acceptance code is written
// only into a separate grading copy after the model exits, never its workspace.
const ts = (id, file, prompt, before, after, test) => ({ id, language: "typescript", file: `src/scoring/${file}.ts`, prompt, before, after, test });
const go = (id, file, prompt, before, after, test) => ({ id, language: "go", file, prompt, before, after,
  test: `package token\nimport "testing"\nfunc TestAcceptance(t *testing.T) {\n${test}\n}\n` });

export const codingCases = [
  ts("ts-weight-normalization", "score-repo",
    "Fix repository overall scoring: when some dimensions are not applicable (score null), divide the weighted sum by the total applicable weight. All unavailable dimensions yield zero. Preserve rounding and the existing dimension weights.",
    ") / totalWeight", ") / 1",
    `const {weightedRepositoryOverall:f}=require('./out/src/scoring/score-repo.js');
const keys=['maintainability','completeness','usability','shipping','consistency','stewardship'];
const dims=(values)=>Object.fromEntries(keys.map(k=>[k,{assessment:{score:values[k]??null}}]));
assert.equal(f(dims({maintainability:80})),80);
assert.equal(f(dims({maintainability:80,stewardship:40})),65);
assert.equal(f(dims({})),0); assert.equal(f(dims({maintainability:0})),0);
assert.equal(f(dims(Object.fromEntries(keys.map(k=>[k,50])))),50);`),
  ts("ts-positive-placeholder", "private-disclosure",
    "Fix redacted private repository name validation: accept exactly 'Private repository' or that phrase followed by a space and a positive decimal integer without leading zeroes. Reject zero and leading-zero suffixes. Preserve private record validation errors and public repository behavior.",
    "[1-9][0-9]*", "[0-9][0-9]*",
    `const {isRedactedPrivateRepositoryName:f,validatePrivateRepositoryRecord:v}=require('./out/src/scoring/private-disclosure.js');
for(const x of ['Private repository','Private repository 1','Private repository 19']) assert.equal(f(x),true,x);
for(const x of ['Private repository 0','Private repository 01','Private repository -1','Private repository ']) assert.equal(f(x),false,x);
v({name:'visible'}); v({name:'Private repository 1',visibility:'private',redactedName:true});
assert.throws(()=>v({name:'Private repository 0',visibility:'private',redactedName:true}),/redacted repository names/);
assert.throws(()=>v({name:'Private repository 1',visibility:'private',redactedName:true,url:'https://example.invalid'}),/omit repository URLs/);`),
  ts("ts-evidence-empty-repo", "evidence",
    "Fix evidence construction: only an undefined repository argument omits the repo property. A supplied empty string must remain present as repo: ''. Preserve label, level, source and metadata, and do not mutate the metadata object.",
    "repo === undefined", "!repo",
    `const {createEvidence:f}=require('./out/src/scoring/evidence.js');
const metadata=Object.freeze({id:'sample'});
const absent=f('high','label','source',undefined,metadata), empty=f('high','label','source','',metadata);
assert.equal(Object.hasOwn(absent,'repo'),false); assert.equal(Object.hasOwn(empty,'repo'),true);
assert.equal(empty.repo,''); assert.equal(empty.id,'sample'); assert.equal(empty.label,'label');
assert.equal(f('high','label','source','a').repo,'a'); assert.deepEqual(metadata,{id:'sample'});`),
  ts("ts-monorepo-threshold", "repository-kind",
    "Fix path-based repository classification: at least two nested package manifests identify a monorepo, including exactly two. Preserve workspace-marker detection, slash and case normalization, and the precedence of monorepo over CLI detection.",
    "nestedPackageManifestCount >= 2", "nestedPackageManifestCount > 2",
    `const {detectRepositoryKindFromPaths:f}=require('./out/src/scoring/repository-kind.js');
const context={sourceFileCount:20,hasReadme:false,hasDemoOrDocs:false};
assert.equal(f(['packages/a/package.json','packages/b/package.json'],context).kind,'monorepo');
assert.equal(f(['packages/a/package.json'],context).kind,'general');
assert.equal(f(['packages/a/package.json','packages/b/package.json','bin/main.ts'],context).kind,'monorepo');
assert.equal(f(['packages\\\\a\\\\Package.JSON','packages\\\\b\\\\package.json'],context).kind,'monorepo');
assert.equal(f(['pnpm-workspace.yaml'],context).kind,'monorepo');`),
  go("go-addline-eof", "position.go",
    "Fix source line registration: AddLine must ignore offsets equal to the file size, duplicate offsets, and decreasing offsets. Valid offsets strictly inside the file must still be registered. Preserve locking and all other position operations.",
    "if i := len(f.lines); (i == 0 || f.lines[i-1] < offset) && offset < f.size {",
    "if i := len(f.lines); (i == 0 || f.lines[i-1] < offset) && offset <= f.size {",
    `f:=NewFileSet().AddFile("a.go",-1,10)
f.AddLine(3); f.AddLine(3); f.AddLine(2); f.AddLine(10)
if f.LineCount()!=2 {t.Fatalf("lines: %v",f.Lines())}
f.AddLine(9); if f.LineCount()!=3 {t.Fatal(f.Lines())}
if f.Position(f.Pos(9)).Line!=3 {t.Fatal("valid line lost")}`),
  go("go-setlines-duplicates", "position.go",
    "Fix SetLines: duplicate adjacent line offsets must be rejected just like decreasing offsets or offsets at the file size. A rejected table must leave the previously installed table intact. Preserve acceptance of a valid increasing table and an empty table.",
    "offset <= lines[i-1]", "offset < lines[i-1]",
    `f:=NewFileSet().AddFile("a.go",-1,10)
if !f.SetLines([]int{0,3,8}) {t.Fatal("valid table rejected")}
for _,bad:=range [][]int{{0,3,3},{0,4,2},{0,10}} {
if f.SetLines(bad) {t.Fatalf("accepted %v",bad)}
if f.LineCount()!=3 || f.Lines()[2]!=8 {t.Fatal("mutated on rejection")}
}
if !f.SetLines(nil) || f.LineCount()!=0 {t.Fatal("empty table rejected")}`),
  go("go-tilde-operator", "token.go",
    "Fix token operator classification: the tilde token is an operator, alongside the normal operators and delimiters. The illegal token and identifiers must not be classified as operators. Do not change token values or token string rendering.",
    "|| tok == TILDE", "|| tok == ILLEGAL",
    `for _,tok:=range []Token{ADD,SEMICOLON,TILDE} {if !tok.IsOperator() {t.Fatalf("not operator: %v",tok)}}
for _,tok:=range []Token{ILLEGAL,IDENT,INT,IF,EOF} {if tok.IsOperator() {t.Fatalf("operator: %v",tok)}}
if TILDE.String()!="~" || ADD.String()!="+" {t.Fatal("spelling changed")}`),
  go("go-leading-digit", "token.go",
    "Fix identifier validation: a leading digit is never valid, including Unicode digits. Later digits are allowed. Preserve Unicode letters, underscores, rejection of keywords and punctuation, and rejection of the empty string.",
    "(i == 0 || !unicode.IsDigit(c))", "(i < 0 || !unicode.IsDigit(c))",
    `for _,name:=range []string{"3x","４hello","","func","a-b"} {if IsIdentifier(name) {t.Fatalf("accepted %q",name)}}
for _,name:=range []string{"x3","_","É４","변수2"} {if !IsIdentifier(name) {t.Fatalf("rejected %q",name)}}`),
];

export function mutateSource(text, task) {
  if (text.split(task.before).length !== 2) throw new Error(`Mutation anchor must be unique: ${task.id}`);
  return text.replace(task.before, task.after);
}
