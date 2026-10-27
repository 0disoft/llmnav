/* llmnav/1 module
id=llmnav.structure.python
role=Extract Python declaration metadata with an isolated standard AST parser without importing application code.
owns=Python syntax metadata|annotation origins|lexical ownership|syntax diagnostics|Python source coordinates
excludes=type checking|import resolution|call inference|application execution
search=Python AST analysis|Python parameter annotations|Python fields|Python UTF16 offsets
invariant=Only explicit annotations provide types and parsing never imports target modules.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

import { runCompiler } from "./process.js";

export async function analyzePython(root, files, options = {}) {
  return JSON.parse(await runCompiler(options.pythonCommand ?? "python", ["-I", "-B", "-c", EXTRACTOR], {
    ...options, cwd: root, input: JSON.stringify({ root, files, allowErrors: options.allowErrors === true }),
  }));
}

// Standard library only. Read source as data; do not import or execute it.
const EXTRACTOR = String.raw`
import ast, hashlib, io, json, pathlib, sys, tokenize
from array import array
from bisect import bisect_right
if sys.version_info < (3, 9):
    raise RuntimeError("Python AST analysis requires Python 3.9 or newer")
request = json.load(sys.stdin)
root = pathlib.Path(request["root"]).resolve()
declarations, diagnostics, hashes = [], [], {}

def annotation(node):
    return ast.unparse(node) if node is not None else None

def parameter(arg, optional=False, variadic=False):
    value = annotation(arg.annotation)
    return dict(name=arg.arg, type=value, typeOrigin="declared" if value else "unknown", optional=optional, variadic=variadic)

for filename in request["files"]:
    absolute = pathlib.Path(filename).resolve()
    relative = absolute.relative_to(root).as_posix()
    data = absolute.read_bytes()
    hashes[relative] = hashlib.sha256(data).hexdigest()
    try:
        encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
        if encoding.lower().replace("_", "-") not in ("utf-8", "utf-8-sig", "ascii"):
            raise SyntaxError("Python analysis requires UTF-8 sources, matching the source-card scanner")
        source = data.decode(encoding)
        tree = ast.parse(source, filename=relative, type_comments=True)
    except (SyntaxError, UnicodeError) as error:
        diagnostics.append(dict(category="Error", code="PY_SYNTAX", path=relative, line=getattr(error, "lineno", 1) or 1, message=str(error)))
        continue
    # Only CR/LF delimit physical Python lines; Unicode separators inside strings do not.
    lines = io.StringIO(source, newline="").readlines()
    starts, offset = [], 1 if data.startswith(b"\xef\xbb\xbf") else 0
    for line in lines:
        starts.append(offset)
        offset += len(line.encode("utf-16-le")) // 2
    corrections = {}

    def source_position(node):
        index, column = node.lineno - 1, node.col_offset
        line = lines[index]
        if line.isascii(): return starts[index] + column
        if index not in corrections:
            ends, deltas = array("I"), array("I")
            byte_column, unit_column = 0, 0
            for character in line:
                codepoint = ord(character)
                byte_width = 1 if codepoint < 0x80 else 2 if codepoint < 0x800 else 3 if codepoint < 0x10000 else 4
                unit_width = 1 if codepoint < 0x10000 else 2
                byte_column += byte_width
                unit_column += unit_width
                if byte_width != unit_width:
                    ends.append(byte_column)
                    deltas.append(byte_column - unit_column)
            corrections[index] = ends, deltas
        ends, deltas = corrections[index]
        correction = bisect_right(ends, column) - 1
        return starts[index] + column - (deltas[correction] if correction >= 0 else 0)

    def add(name, node, category, parent, value=None, signatures=None, parameters=None):
        line = getattr(node, "lineno", 1)
        position = source_position(node)
        key = relative + ":" + str(position) + ":" + category + ":" + name
        qualified = (parent["qualified"] if parent else "module") + "/" + category + ":" + name
        item = dict(key=key, symbol=name, path=relative, line=line, offset=position, kind=category, qualified=qualified)
        if parent: item["parent"] = parent["key"]
        item["metadata"] = dict(language="python", precision="syntax", category=category, owner=parent["key"] if parent else None,
            status="partial", type=value, typeOrigin="declared" if value else "unknown", signatures=signatures or [], parameters=parameters or [])
        declarations.append(item)
        return item

    module = dict(key=relative+":module", symbol=absolute.name, path=relative, line=1, offset=-1, kind="module", qualified="module")
    declarations.append(module)

    def visit(node, owner):
        if isinstance(node, ast.ClassDef):
            item = add(node.name, node, "type", owner)
            for child in node.body: visit(child, item)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            positional = args.posonlyargs + args.args
            parameters = [parameter(arg, i >= len(positional)-len(args.defaults)) for i, arg in enumerate(positional)]
            if args.vararg: parameters.append(parameter(args.vararg, variadic=True))
            parameters.extend(parameter(arg, default is not None) for arg, default in zip(args.kwonlyargs, args.kw_defaults))
            if args.kwarg: parameters.append(parameter(args.kwarg, variadic=True))
            signature = ("async " if isinstance(node, ast.AsyncFunctionDef) else "") + "def " + node.name + "(" + ast.unparse(args) + ")"
            if node.returns: signature += " -> " + annotation(node.returns)
            item = add(node.name, node, "method" if owner["kind"] == "type" else "function", owner, annotation(node.returns), [signature], parameters)
            if owner["kind"] == "type": item["display"] = owner["symbol"] + "." + node.name
            all_args = positional + ([args.vararg] if args.vararg else []) + args.kwonlyargs + ([args.kwarg] if args.kwarg else [])
            for arg in all_args: add(arg.arg, arg, "parameter", item, annotation(arg.annotation))
            for child in node.body: visit(child, item)
            return
        if isinstance(node, (ast.AnnAssign, ast.Assign)) and owner["kind"] in ("module", "type"):
            targets = [node.target] if isinstance(node, ast.AnnAssign) else node.targets
            value = annotation(node.annotation) if isinstance(node, ast.AnnAssign) else None
            for target in targets:
                if isinstance(target, ast.Name): add(target.id, target, "field" if owner["kind"] == "type" else "variable", owner, value)
            return
        for child in ast.iter_child_nodes(node): visit(child, owner)

    for node in tree.body: visit(node, module)

if diagnostics and not request["allowErrors"]:
    print(json.dumps(diagnostics), file=sys.stderr)
    sys.exit(1)
print(json.dumps(dict(compiler=dict(name="python-ast", version=sys.version.split()[0]), precision="syntax",
    limitations=["Syntax only: annotations are not type-checked; imports, dynamic attributes, instance assignments and call targets are not resolved.",
        "Decorators, type comments, destructuring and generic type parameters are not separate definitions."],
    declarations=declarations, references=[], diagnostics=diagnostics, configHashes=hashes)))
`;
