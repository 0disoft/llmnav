/* llmnav/1 module
id=llmnav.structure.typescript-metadata
role=Project compiler types and callable signatures into generated declaration metadata.
owns=TypeScript type origins|callable parameters|metadata categories
excludes=compiler installation|source mutation|business meaning inference|semantic card validation
search=TypeScript signature metadata|parameter types|inferred types
invariant=Only compiler-resolved types and declarations supply metadata and type origins.
rel=workflow>llmnav.structure.typescript-worker
stability=architecture
*/

export function typeScriptMetadata(ts, checker, node, partial, language = "typescript") {
  const type = ts.isTypeAliasDeclaration(node) ? checker.getTypeFromTypeNode(node.type) : checker.getTypeAtLocation(node.name);
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const callable = ts.isFunctionLike(node) ? node : node.initializer && ts.isFunctionLike(node.initializer) ? node.initializer : null;
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const signature = callable ? checker.getSignatureFromDeclaration(callable) : signatures[0];
  const declared = Boolean(node.type || ts.getJSDocType?.(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node));
  const unknown = type.intrinsicName === "error" || language === "javascript" && !declared && Boolean(type.flags & ts.TypeFlags.Any);
  return {
    language, category: category(ts, node, callable), owner: null,
    status: partial || unknown ? "partial" : "available",
    type: unknown ? null : checker.typeToString(type, node, flags),
    typeOrigin: unknown ? "unknown" : declared ? "declared" : "inferred",
    signatures: signatures.map(item => checker.signatureToString(item, node, flags)),
    parameters: (signature?.parameters ?? []).map(parameter => {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      const parameterType = checker.getTypeOfSymbolAtLocation(parameter, declaration ?? node);
      const annotated = declaration?.type || declaration && ts.getJSDocType?.(declaration);
      const unresolved = parameterType.intrinsicName === "error" || language === "javascript" && !annotated && Boolean(parameterType.flags & ts.TypeFlags.Any);
      return { name: parameter.name, type: unresolved ? null : checker.typeToString(parameterType, declaration ?? node, flags),
        typeOrigin: unresolved ? "unknown" : annotated ? "declared" : "inferred",
        optional: Boolean(parameter.flags & ts.SymbolFlags.Optional || declaration?.questionToken || declaration?.initializer),
        variadic: Boolean(declaration?.dotDotDotToken) };
    }),
  };
}

function category(ts, node, callable) {
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "field";
  if (ts.isParameter(node)) return "parameter";
  if (ts.isFunctionDeclaration(node) || callable) return "function";
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return "type";
  return "variable";
}
