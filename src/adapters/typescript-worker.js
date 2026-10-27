/* llmnav/1 module
id=llmnav.structure.typescript-worker
role=Resolve TypeScript declarations and symbol uses through the compiler type checker without emitting code.
owns=compiler symbol identity|alias resolution|lexical owners|TypeScript diagnostics|selected source consumption hashes
excludes=dependency installation|project execution
search=TypeScript precise references|renamed imports|type checker symbols
invariant=Analysis executes only explicitly selected compiler tooling and never project application code.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

// Isolated compiler API host: never emits JavaScript or loads tsconfig plugins.
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { typeScriptMetadata } from "./typescript-metadata.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
try { console.log(JSON.stringify(analyze(JSON.parse(input)))); }
catch (error) { console.error(error.message); process.exitCode = 1; }

function analyze(request) {
  const ts = createRequire(import.meta.url)(request.compiler);
  if (!/^[56]\./u.test(ts.version ?? "") || typeof ts.createProgram !== "function") {
    throw new Error("This adapter supports TypeScript Compiler API 5.x and 6.x. Native TypeScript 7 requires its own API adapter.");
  }
  const root = path.resolve(request.root);
  const selectedPaths = request.files.map(file => path.resolve(file));
  const configHashes = Object.create(null);
  const javascript = request.language === "javascript";
  let options = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, skipLibCheck: true, types: [] };
  let names = selectedPaths;
  if (javascript) Object.assign(options, { allowJs: true, checkJs: true, noImplicitAny: false });
  if (request.project) {
    const project = path.resolve(root, request.project);
    if (!inside(root, project)) throw new Error("TypeScript project must be inside the repository.");
    const loaded = ts.readConfigFile(project, readConfig);
    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(loaded.config, { ...ts.sys, readFile: readConfig }, path.dirname(project));
    if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
    options = { ...parsed.options, noEmit: true, incremental: false };
    if (javascript) Object.assign(options, { allowJs: true, checkJs: true });
    names = parsed.fileNames;
  }
  const host = ts.createCompilerHost(options);
  // Compare file identities with the compiler's case rules, but emit scanner-owned spelling.
  const fileKey = file => host.getCanonicalFileName(path.resolve(file));
  const selected = new Map(selectedPaths.map(file => [fileKey(file), file]));
  names = names.map(file => selected.get(fileKey(file))).filter(file => file !== undefined);
  const originalRead = host.readFile;
  const inputs = new Set();
  host.readFile = file => {
    const absolute = path.resolve(file);
    if (inside(root, absolute)) {
      let canonical;
      try { canonical = realpathSync(absolute); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return originalRead(file); throw error; }
      if (!inside(root, canonical)) throw new Error("Compiler input traverses a symlink outside the repository.");
      inputs.add(absolute);
      // Hash the bytes actually consumed, so an edit followed by undo cannot
      // publish declarations from a different source version than the scan.
      const source = selected.get(fileKey(absolute));
      if (javascript || source !== undefined || path.basename(absolute) === "package.json") return readConfig(source ?? absolute);
    }
    return originalRead(file);
  };
  const program = ts.createProgram(names, options, host);
  const checker = program.getTypeChecker();
  const diagnostics = ts.getPreEmitDiagnostics(program).map(error => ({
    category: ts.DiagnosticCategory[error.category], code: String(error.code),
    path: error.file && inside(root, error.file.fileName) ? relative(error.file.fileName) : null,
    line: error.file ? error.file.getLineAndCharacterOfPosition(error.start ?? 0).line + 1 : null,
    message: ts.flattenDiagnosticMessageText(error.messageText, "\n"),
  }));
  if (!request.allowErrors && diagnostics.some(error => error.category === "Error")) throw new Error(JSON.stringify(diagnostics));
  const declarations = [], references = [], bySymbol = new Map(), byDeclaration = new Map(), owners = new Map();
  const sources = program.getSourceFiles().filter(source => selected.has(fileKey(source.fileName)));
  const partial = diagnostics.some(item => item.category === "Error");
  for (const source of sources) {
    const module = { key: `${relative(source.fileName)}:module`, symbol: path.basename(relative(source.fileName)), path: relative(source.fileName), line: 1, offset: -1, kind: "module", qualified: "module" };
    declarations.push(module); owners.set(source, module.key);
    function definitions(node, scope) {
      let next = scope;
      if (node.name && ts.isIdentifier(node.name) && isDeclaration(node)) {
        let symbol = checker.getSymbolAtLocation(node.name);
        if (symbol && !bySymbol.has(symbol)) {
          const declaration = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
            ? symbol.declarations?.find(candidate => candidate.kind === node.kind && candidate.body && candidate.getSourceFile() === source) ?? node
            : node;
          const kind = ts.SyntaxKind[node.kind];
          const key = `${relative(source.fileName)}:${declaration.getStart(source)}`;
          const qualified = `${scope}/${kind}:${node.name.text}`;
          const display = (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.parent.name ? `${node.parent.name.text}.${node.name.text}` : node.name.text;
          const record = { key, symbol: node.name.text, display, path: relative(source.fileName), line: source.getLineAndCharacterOfPosition(declaration.name.getStart(source)).line + 1, offset: declaration.getStart(source), kind, qualified, parent: nearestOwner(node.parent) };
          if (request.metadata) record.metadata = typeScriptMetadata(ts, checker, declaration, partial, javascript ? "javascript" : "typescript");
          // Retain card attachment to the first signature when the implementation has no card.
          if (declaration !== node) {
            record.signatureOffset = node.getStart(source);
            record.signatureLine = source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1;
          }
          declarations.push(record); bySymbol.set(symbol, key); byDeclaration.set(node, key); byDeclaration.set(declaration, key); owners.set(node, key); next = qualified;
        } else if (symbol) { byDeclaration.set(node, bySymbol.get(symbol)); owners.set(node, bySymbol.get(symbol)); next = `${scope}/${node.name.text}`; }
      }
      ts.forEachChild(node, child => definitions(child, next));
    }
    definitions(source, "module");
  }
  for (const source of sources) {
    function uses(node) {
      if (ts.isIdentifier(node) && !isName(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const to = bySymbol.get(symbol) ?? symbol?.declarations?.map(declaration => byDeclaration.get(declaration)).find(Boolean), from = nearestUseOwner(node);
        if (from && to && from !== to) {
          const call = isCallTarget(node);
          references.push({ from, to, kind: call ? "calls" : "references", path: relative(source.fileName), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        }
      }
      ts.forEachChild(node, uses);
    }
    uses(source);
  }
  return { compiler: { name: "typescript", version: ts.version }, declarations, references, diagnostics, inputs: [...inputs].map(relative), configHashes };
  function readConfig(file) {
    const absolute = path.resolve(file);
    let bytes;
    try {
      const canonical = realpathSync(absolute);
      if (!inside(root, absolute) || !inside(root, canonical)) throw new Error("TypeScript configuration must stay inside the repository without escaping symlinks.");
      bytes = readFileSync(absolute);
    } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined; throw error; }
    const name = path.relative(root, absolute).split(path.sep).join("/");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (configHashes[name] !== undefined && configHashes[name] !== hash) throw new Error(`Compiler input changed during analysis: ${name}. Run analysis again.`);
    configHashes[name] = hash;
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    return new TextDecoder(encoding).decode(bytes);
  }
  function relative(file) { return path.relative(root, selected.get(fileKey(file)) ?? file).split(path.sep).join("/"); }
  function isCallTarget(node) {
    let expression = node;
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) expression = node.parent;
    while (expression.parent && (ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) || ts.isTypeAssertionExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent))) {
      expression = expression.parent;
    }
    return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
  }
  function nearestOwner(node) { for (let current = node; current; current = current.parent) if (owners.has(current)) return owners.get(current); return null; }
  function nearestUseOwner(node) {
    for (let current = node; current; current = current.parent) {
      if (!owners.has(current) || ts.isParameter(current)) continue;
      if (ts.isVariableDeclaration(current) && !(current.initializer && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer)))) {
        let callable = false;
        for (let parent = current.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
          if (ts.isFunctionLike(parent)) { callable = true; break; }
        }
        if (callable) continue;
      }
      return owners.get(current);
    }
    return null;
  }
  function isDeclaration(node) { return ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isMethodSignature(node) || ts.isPropertySignature(node); }
  function isName(node) { return node.parent?.name === node && isDeclaration(node.parent) || ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent); }
}
function inside(root, file) { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
