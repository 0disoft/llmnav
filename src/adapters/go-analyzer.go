/* llmnav/1 module
id=llmnav.structure.go-worker
role=Resolve Go object identity and lexical references from standard-library type information.
owns=Go declaration identity|cross-package reference resolution|receiver identity|physical source positions
excludes=project execution|module installation|runtime dispatch inference
search=Go precise references|go types definitions|Go receiver methods
invariant=Compiler-selected production sources determine references and line directives never replace physical locations.
rel=workflow>llmnav.structure.analyze
stability=architecture
*/

// The Go adapter uses only standard-library compiler packages.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type request struct {
	Root        string
	Files       []string
	Listing     string
	AllowErrors bool
}
type listedPackage struct {
	ImportPath, Dir, Export string
	GoFiles                 []string
}
type declaration struct {
	Display   string `json:"display,omitempty"`
	Key       string `json:"key"`
	Symbol    string `json:"symbol"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Offset    int    `json:"offset"`
	Kind      string `json:"kind"`
	Qualified string `json:"qualified"`
	Parent    string `json:"parent,omitempty"`
}
type reference struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
	Path string `json:"path"`
	Line int    `json:"line"`
}
type report struct {
	Compiler     map[string]string `json:"compiler"`
	Declarations []declaration     `json:"declarations"`
	References   []reference       `json:"references"`
	Diagnostics  []string          `json:"diagnostics"`
	Inputs       []string          `json:"inputs"`
}
type analyzer struct {
	request  request
	fset     *token.FileSet
	listed   map[string]listedPackage
	packages map[string]*types.Package
	infos    map[string]*types.Info
	syntax   map[string][]*ast.File
	checking map[string]bool
	fallback types.Importer
	selected map[string]bool
	objects  map[types.Object]string
	owners   map[ast.Node]string
	report   report
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	a := &analyzer{request: input, fset: token.NewFileSet(), listed: map[string]listedPackage{}, packages: map[string]*types.Package{}, infos: map[string]*types.Info{}, syntax: map[string][]*ast.File{}, checking: map[string]bool{}, selected: map[string]bool{}, objects: map[types.Object]string{}, owners: map[ast.Node]string{}}
	a.report = report{Compiler: map[string]string{"name": "go/types", "version": runtime.Version()}, Declarations: []declaration{}, References: []reference{}, Diagnostics: []string{}, Inputs: []string{}}
	for _, file := range input.Files {
		a.selected[filepath.Clean(file)] = true
	}
	decoder := json.NewDecoder(strings.NewReader(input.Listing))
	for {
		var pkg listedPackage
		err := decoder.Decode(&pkg)
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		a.listed[pkg.ImportPath] = pkg
	}
	a.fallback = importer.ForCompiler(a.fset, "gc", func(name string) (io.ReadCloser, error) {
		pkg, ok := a.listed[name]
		if !ok || pkg.Export == "" {
			return nil, fmt.Errorf("no export data for %s", name)
		}
		return os.Open(pkg.Export)
	})
	names := []string{}
	for name, pkg := range a.listed {
		if a.inside(pkg.Dir) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if _, err := a.Import(name); err != nil {
			if !input.AllowErrors {
				return err
			}
			a.report.Diagnostics = append(a.report.Diagnostics, err.Error())
		}
	}
	for _, name := range names {
		a.collect(name)
	}
	for _, name := range names {
		a.references(name)
	}
	sort.Strings(a.report.Inputs)
	sort.Strings(a.report.Diagnostics)
	return json.NewEncoder(os.Stdout).Encode(a.report)
}
func (a *analyzer) inside(file string) bool {
	relative, err := filepath.Rel(a.request.Root, file)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
func (a *analyzer) relative(file string) string {
	relative, _ := filepath.Rel(a.request.Root, file)
	return filepath.ToSlash(relative)
}
func (a *analyzer) Import(name string) (*types.Package, error) {
	if pkg := a.packages[name]; pkg != nil {
		return pkg, nil
	}
	pkg, ok := a.listed[name]
	if !ok || !a.inside(pkg.Dir) {
		return a.fallback.Import(name)
	}
	if a.checking[name] {
		return nil, fmt.Errorf("import cycle at %s", name)
	}
	a.checking[name] = true
	defer delete(a.checking, name)
	files := []*ast.File{}
	for _, base := range pkg.GoFiles {
		file := filepath.Join(pkg.Dir, base)
		canonical, err := filepath.EvalSymlinks(file)
		if err != nil {
			return nil, err
		}
		if !a.inside(canonical) {
			return nil, fmt.Errorf("source symlink escapes repository: %s", file)
		}
		syntax, err := parser.ParseFile(a.fset, file, nil, 0)
		if err != nil {
			return nil, err
		}
		files = append(files, syntax)
		a.report.Inputs = append(a.report.Inputs, a.relative(file))
	}
	info := &types.Info{Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
	config := types.Config{Importer: a, Error: func(err error) { a.report.Diagnostics = append(a.report.Diagnostics, err.Error()) }}
	checked, err := config.Check(name, a.fset, files, info)
	if err != nil && !a.request.AllowErrors {
		return nil, err
	}
	if checked == nil {
		return nil, fmt.Errorf("cannot type check %s", name)
	}
	a.packages[name] = checked
	a.infos[name] = info
	a.syntax[name] = files
	return checked, nil
}
func (a *analyzer) collect(name string) {
	info := a.infos[name]
	if info == nil {
		return
	}
	for _, file := range a.syntax[name] {
		position := a.fset.PositionFor(file.Pos(), false)
		if !a.selected[filepath.Clean(position.Filename)] {
			continue
		}
		relative := a.relative(position.Filename)
		module := relative + ":module"
		a.owners[file] = module
		qualifiedNames := map[string]string{module: "module"}
		a.report.Declarations = append(a.report.Declarations, declaration{Key: module, Symbol: filepath.Base(relative), Path: relative, Line: 1, Offset: -1, Kind: "module", Qualified: "module"})
		stack := []ast.Node{}
		scopes := []string{}
		ast.Inspect(file, func(node ast.Node) bool {
			if node == nil {
				stack = stack[:len(stack)-1]
				scopes = scopes[:len(scopes)-1]
				return true
			}
			parent := module
			scope := "module"
			if len(scopes) > 0 {
				scope = scopes[len(scopes)-1]
			}
			for i := len(stack) - 1; i >= 0; i-- {
				if owner := a.owners[stack[i]]; owner != "" {
					parent = owner
					break
				}
			}
			if id, ok := node.(*ast.Ident); ok {
				if object := info.Defs[id]; object != nil && id.Name != "_" {
					kind := objectKind(object)
					pos := a.fset.PositionFor(id.Pos(), false)
					key := fmt.Sprintf("%s:%d", relative, pos.Offset)
					qualified := qualifiedNames[parent] + "/" + kind + ":" + id.Name
					display := id.Name
					// Receiver identity distinguishes same-named methods on different types.
					if function, ok := object.(*types.Func); ok {
						if signature, ok := function.Type().(*types.Signature); ok && signature.Recv() != nil {
							qualified += ":" + types.TypeString(signature.Recv().Type(), func(p *types.Package) string { return p.Path() })
							display = strings.TrimPrefix(types.TypeString(signature.Recv().Type(), func(p *types.Package) string { return "" }), "*") + "." + id.Name
						}
					}
					a.objects[object] = key
					qualifiedNames[key] = qualified
					a.report.Declarations = append(a.report.Declarations, declaration{Key: key, Symbol: id.Name, Display: display, Path: relative, Line: pos.Line, Offset: pos.Offset, Kind: kind, Qualified: qualified, Parent: parent})
					// Function/type/value nodes own subsequent body uses, not their name identifier.
					if len(stack) > 0 {
						owner := stack[len(stack)-1]
						switch owner.(type) {
						case *ast.FuncDecl, *ast.TypeSpec:
							a.owners[owner] = key
						case *ast.ValueSpec:
							if ownsValue(owner.(*ast.ValueSpec), stack) {
								a.owners[owner] = key
							}
						}
					}
				}
			}
			if owner := a.owners[node]; owner != "" {
				scope = owner
			}
			stack = append(stack, node)
			scopes = append(scopes, scope)
			return true
		})
	}
}
func objectKind(object types.Object) string {
	switch object.(type) {
	case *types.Func:
		return "function"
	case *types.TypeName:
		return "type"
	case *types.Const:
		return "constant"
	case *types.Var:
		return "variable"
	default:
		return "binding"
	}
}

// Ordinary local initializers execute in their enclosing callable. Function
// literals keep a value owner so their deferred body uses do not leak outward.
func ownsValue(value *ast.ValueSpec, stack []ast.Node) bool {
	for _, expression := range value.Values {
		if _, ok := expression.(*ast.FuncLit); ok {
			return true
		}
	}
	for _, node := range stack {
		switch node.(type) {
		case *ast.FuncDecl, *ast.FuncLit:
			return false
		}
	}
	return true
}

// Explicit type arguments and parentheses wrap the callee without changing it.
func callTarget(expression ast.Expr) ast.Expr {
	for {
		switch node := expression.(type) {
		case *ast.IndexExpr:
			expression = node.X
		case *ast.IndexListExpr:
			expression = node.X
		case *ast.ParenExpr:
			expression = node.X
		default:
			return expression
		}
	}
}
func (a *analyzer) references(name string) {
	info := a.infos[name]
	if info == nil {
		return
	}
	for _, file := range a.syntax[name] {
		position := a.fset.PositionFor(file.Pos(), false)
		if !a.selected[filepath.Clean(position.Filename)] {
			continue
		}
		stack := []ast.Node{}
		ast.Inspect(file, func(node ast.Node) bool {
			if node == nil {
				stack = stack[:len(stack)-1]
				return true
			}
			if id, ok := node.(*ast.Ident); ok {
				if to := a.objects[info.Uses[id]]; to != "" {
					from := ""
					for i := len(stack) - 1; i >= 0; i-- {
						if owner := a.owners[stack[i]]; owner != "" {
							from = owner
							break
						}
					}
					if from != "" && from != to {
						kind := "references"
						if _, ok := info.Uses[id].(*types.Func); ok {
							for i := len(stack) - 1; i >= 0; i-- {
								call, ok := stack[i].(*ast.CallExpr)
								if !ok {
									continue
								}
								target := callTarget(call.Fun)
								selector, member := target.(*ast.SelectorExpr)
								if target == id || member && selector.Sel == id {
									kind = "calls"
								}
								break
							}
						}
						pos := a.fset.PositionFor(id.Pos(), false)
						a.report.References = append(a.report.References, reference{from, to, kind, a.relative(pos.Filename), pos.Line})
					}
				}
			}
			stack = append(stack, node)
			return true
		})
	}
}
