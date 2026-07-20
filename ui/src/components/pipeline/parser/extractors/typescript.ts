/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * TypeScript/TSX symbol extractor using web-tree-sitter.
 * Ported from agent/src/opentrace_agent/sources/code/extractors/typescript_extractor.py
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CallRef, CodeSymbol, ExtractionResult } from '../../types';

const CLASS_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
]);
const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
]);
const METHOD_TYPES = new Set(['method_definition', 'public_field_definition']);

/** Higher-order component / wrapper calls whose function argument IS the real
 *  component body. Without unwrapping these, `const C = forwardRef((p) => {…})`
 *  extracts NO symbol — so every call the component makes (e.g. a React ref's
 *  `rendererRef.current.foo()`) has no caller and never becomes a CALLS edge.
 *  Handles nesting like `memo(forwardRef(fn))`. */
const HOC_WRAPPERS = new Set([
  'forwardRef',
  'memo',
  'React.forwardRef',
  'React.memo',
  'observer',
]);

/** React ref-wrapper type names: `useRef<T>()` / a var typed `RefObject<T>`
 *  holds T on its `.current`, so calls read as `<var>.current.method()`. */
const REF_WRAPPER_TYPES = new Set([
  'RefObject',
  'MutableRefObject',
  'Ref',
  'LegacyRef',
]);
const REF_FACTORY_CALLS = new Set([
  'useRef',
  'createRef',
  'React.useRef',
  'React.createRef',
]);

/** Extract a JSDoc/TSDoc comment from the preceding sibling of an AST node.
 *  Checks both the node itself and its parent (for `export_statement` wrapping). */
function extractJSDoc(node: SyntaxNode): string | undefined {
  let prev = node.previousNamedSibling;
  // If no JSDoc on the node itself, check the parent (handles `export function ...`)
  if (
    (!prev || prev.type !== 'comment') &&
    node.parent?.type === 'export_statement'
  ) {
    prev = node.parent.previousNamedSibling;
  }
  if (!prev || prev.type !== 'comment') return undefined;
  const text = prev.text;
  if (!text.startsWith('/**')) return undefined;
  // Strip /** ... */ delimiters and leading ` * ` prefixes
  const cleaned = text
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  return cleaned || undefined;
}

export function extractTypeScript(
  rootNode: SyntaxNode,
  language = 'typescript',
): ExtractionResult {
  const symbols = walkNode(rootNode);
  return { symbols, language, rootNode };
}

function walkNode(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    if (CLASS_TYPES.has(child.type)) {
      const sym = extractClass(child);
      if (sym) symbols.push(sym);
    } else if (FUNCTION_TYPES.has(child.type)) {
      const sym = extractFunction(child);
      if (sym) symbols.push(sym);
    } else if (child.type === 'lexical_declaration') {
      symbols.push(...extractLexicalDeclaration(child));
    } else if (child.type === 'export_statement') {
      // Unwrap `export class ...` / `export function ...`
      symbols.push(...walkNode(child));
    }
  }
  return symbols;
}

function extractClass(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const children = walkClassBody(node);
  const { superclasses, interfaces } = extractClassHeritage(node);
  const docs = extractJSDoc(node);
  return {
    name: nameNode.text,
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: null,
    children,
    calls: [],
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    superclasses: superclasses.length > 0 ? superclasses : undefined,
    interfaces: interfaces.length > 0 ? interfaces : undefined,
    docs,
  };
}

/** Extract extends/implements from a class_heritage child. */
function extractClassHeritage(node: SyntaxNode): {
  superclasses: string[];
  interfaces: string[];
} {
  const superclasses: string[] = [];
  const interfaces: string[] = [];
  for (const child of node.children) {
    if (child.type === 'class_heritage') {
      for (const clause of child.children) {
        if (clause.type === 'extends_clause') {
          superclasses.push(...collectHeritageNames(clause));
        } else if (clause.type === 'implements_clause') {
          interfaces.push(...collectHeritageNames(clause));
        }
      }
    }
  }
  return { superclasses, interfaces };
}

/** Collect type names from an extends/implements clause. */
function collectHeritageNames(clause: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of clause.children) {
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      names.push(child.text);
    } else if (child.type === 'generic_type') {
      // e.g., `Map<string, number>` — extract just the base name
      const nameNode = child.childForFieldName('name');
      if (nameNode) names.push(nameNode.text);
    }
  }
  return names;
}

function walkClassBody(node: SyntaxNode): CodeSymbol[] {
  const body = node.childForFieldName('body');
  if (!body) return [];
  const methods: CodeSymbol[] = [];
  for (const child of body.children) {
    if (METHOD_TYPES.has(child.type)) {
      const sym = extractMethod(child);
      if (sym) methods.push(sym);
    }
  }
  return methods;
}

function extractFunction(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const typeSignature = paramsNode ? extractTypeSignature(paramsNode) : null;
  const returnType = extractReturnType(node);
  const bodyNode = node.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  const docs = extractJSDoc(node);
  return {
    name: nameNode.text,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar: null,
    receiverType: null,
    paramTypes: collectVarTypes(paramsNode, bodyNode),
    docs,
    typeSignature,
    returnType,
  };
}

function extractMethod(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const typeSignature = paramsNode ? extractTypeSignature(paramsNode) : null;
  const returnType = extractReturnType(node);
  const bodyNode = node.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  const docs = extractJSDoc(node);
  return {
    name: nameNode.text,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar: null,
    receiverType: null,
    paramTypes: collectVarTypes(paramsNode, bodyNode),
    docs,
    typeSignature,
    returnType,
  };
}

function extractLexicalDeclaration(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    if (child.type === 'variable_declarator') {
      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !valueNode) continue;
      const name = nameNode.text;
      if (
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression'
      ) {
        const sym = extractArrowFunction(name, node, valueNode);
        if (sym) symbols.push(sym);
      } else if (valueNode.type === 'class') {
        const sym = extractClassExpression(name, node, valueNode);
        if (sym) symbols.push(sym);
      } else {
        // HOC-wrapped component: `const C = forwardRef((p, r) => {…})` /
        // `memo(forwardRef(fn))`. Unwrap to the inner function so the
        // component's body (and every call it makes) is extracted.
        const hocFn = unwrapHocFunction(valueNode);
        if (hocFn) {
          const sym = extractArrowFunction(name, node, hocFn);
          if (sym) symbols.push(sym);
        }
      }
    }
  }
  return symbols;
}

function extractArrowFunction(
  name: string,
  declNode: SyntaxNode,
  valueNode: SyntaxNode,
): CodeSymbol {
  const paramsNode = valueNode.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const typeSignature = paramsNode ? extractTypeSignature(paramsNode) : null;
  const returnType = extractReturnType(valueNode);
  const bodyNode = valueNode.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  const docs = extractJSDoc(declNode);
  return {
    name,
    kind: 'function',
    startLine: declNode.startPosition.row + 1,
    endLine: declNode.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar: null,
    receiverType: null,
    paramTypes: collectVarTypes(paramsNode, bodyNode),
    docs,
    typeSignature,
    returnType,
  };
}

function extractClassExpression(
  name: string,
  declNode: SyntaxNode,
  valueNode: SyntaxNode,
): CodeSymbol {
  const children = walkClassBody(valueNode);
  const { superclasses, interfaces } = extractClassHeritage(valueNode);
  const docs = extractJSDoc(declNode);
  return {
    name,
    kind: 'class',
    startLine: declNode.startPosition.row + 1,
    endLine: declNode.endPosition.row + 1,
    signature: null,
    children,
    calls: [],
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    superclasses: superclasses.length > 0 ? superclasses : undefined,
    interfaces: interfaces.length > 0 ? interfaces : undefined,
    docs,
  };
}

/** Build a Java-style type signature from TS/JS parameter type annotations.
 *  Returns "()" for zero-param functions, "(string,number)" when all params are typed,
 *  or null when any param lacks a type annotation. */
function extractTypeSignature(paramsNode: SyntaxNode): string | null {
  const types: string[] = [];
  let paramCount = 0;

  for (const child of paramsNode.namedChildren) {
    if (
      child.type === 'required_parameter' ||
      child.type === 'optional_parameter'
    ) {
      paramCount++;
      const typeAnnotation = child.childForFieldName('type');
      if (typeAnnotation) {
        types.push(normalizeTypeName(typeAnnotation.text));
      }
    } else if (child.type === 'rest_parameter') {
      paramCount++;
      const typeAnnotation = child.childForFieldName('type');
      if (typeAnnotation) {
        types.push(normalizeTypeName(typeAnnotation.text) + '[]');
      }
    }
  }

  // Zero params → "()" for typed languages
  if (paramCount === 0) return '()';
  // All params must be typed for a valid signature
  if (types.length !== paramCount) return null;
  return `(${types.join(',')})`;
}

/** Extract the return type annotation from a function/method/arrow node. */
function extractReturnType(node: SyntaxNode): string | null {
  const returnTypeNode = node.childForFieldName('return_type');
  if (!returnTypeNode) return null;
  return normalizeTypeName(returnTypeNode.text);
}

/** Normalize a type annotation to a clean Java-style type name. */
function normalizeTypeName(raw: string): string {
  return raw
    .replace(/\s+/g, '') // strip whitespace
    .split('.')
    .pop()!; // take leaf of qualified names
}

function collectCalls(node: SyntaxNode): CallRef[] {
  const calls: CallRef[] = [];

  // Extract call from this node (handles both direct call_expression nodes
  // like concise arrow bodies, and call_expression children found via recursion)
  if (node.type === 'call_expression') {
    const funcNode = node.childForFieldName('function');
    if (funcNode && funcNode.type === 'identifier') {
      calls.push({ name: funcNode.text, receiver: null, kind: 'bare' });
    } else if (funcNode && funcNode.type === 'member_expression') {
      const objNode = funcNode.childForFieldName('object');
      const propNode = funcNode.childForFieldName('property');
      if (objNode && propNode) {
        calls.push({
          name: propNode.text,
          receiver: objNode.text,
          kind: 'attribute',
        });
      }
    }
  }

  for (const child of node.children) {
    calls.push(...collectCalls(child));
  }
  return calls;
}

/** Extract a bare class name from a type expression, or null if it isn't a
 *  usable class-like name. Handles `: T` annotations, `A | null` unions,
 *  `Foo<Bar>` generics, and qualified `a.b.C` names. PascalCase-gated to skip
 *  primitives (`string`, `number`); the resolver additionally requires the name
 *  to be a known class, so an interface/type-alias name here resolves to
 *  nothing rather than a wrong edge. */
function classNameFromType(raw: string): string | null {
  const s = raw.replace(/^\s*:\s*/, '').trim();
  const member = s
    .split('|')
    .map((p) => p.trim())
    .find((p) => p && p !== 'null' && p !== 'undefined');
  if (!member) return null;
  // Strip generic args, then take the leaf of a qualified name.
  const base = member.replace(/<.*$/, '').trim().split('.').pop();
  if (!base) return null;
  return /^[A-Z]/.test(base) ? base : null;
}

/** If a type expression is a React ref wrapper (`RefObject<Foo>`), return the
 *  inner class name — the type held on `.current`. */
function refWrapperInner(raw: string): string | null {
  const s = raw.replace(/^\s*:\s*/, '').trim();
  const m = s.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
  if (!m || !REF_WRAPPER_TYPES.has(m[1])) return null;
  return classNameFromType(m[2]);
}

/** If a value is a ref factory call (`useRef<Foo>(…)`), return the inner class
 *  name so the caller keys the type on `<var>.current`. */
function refFactoryInner(valueNode: SyntaxNode | null): string | null {
  if (!valueNode || valueNode.type !== 'call_expression') return null;
  const fn = valueNode.childForFieldName('function');
  if (!fn || !REF_FACTORY_CALLS.has(fn.text)) return null;
  const typeArgs = valueNode.childForFieldName('type_arguments');
  if (!typeArgs) return null;
  for (const t of typeArgs.namedChildren) {
    const inner = classNameFromType(t.text);
    if (inner) return inner;
  }
  return null;
}

/** Recursively map local `const`/`let` declarations to class types within a
 *  function body. Keys are the exact receiver text a call site produces, so a
 *  ref keys on `${name}.current` and a plain instance on `${name}`. */
function collectLocalVarTypes(
  node: SyntaxNode,
  map: Record<string, string>,
): void {
  if (node.type === 'variable_declarator') {
    const nameNode = node.childForFieldName('name');
    if (nameNode && nameNode.type === 'identifier') {
      const name = nameNode.text;
      const typeNode = node.childForFieldName('type');
      const valueNode = node.childForFieldName('value');
      // 1. Ref: `useRef<Foo>(…)` or a var typed `RefObject<Foo>` → foo on .current
      const refInner =
        refFactoryInner(valueNode) ??
        (typeNode ? refWrapperInner(typeNode.text) : null);
      if (refInner) {
        map[`${name}.current`] = refInner;
      } else if (typeNode) {
        // 2. Annotated instance: `const r: Foo = …`
        const t = classNameFromType(typeNode.text);
        if (t) map[name] = t;
      } else if (valueNode && valueNode.type === 'new_expression') {
        // 3. Constructor: `const r = new Foo()`
        const ctor = valueNode.childForFieldName('constructor');
        if (ctor) {
          const t = classNameFromType(ctor.text);
          if (t) map[name] = t;
        }
      }
    }
  }
  for (const child of node.children) collectLocalVarTypes(child, map);
}

/** Build a variable → class-type map for a function scope, powering the
 *  resolver's type-hint strategy (Strategy 2.5) so `r.method()` and
 *  `ref.current.method()` resolve to the class's methods. Captures typed
 *  params, `new Foo()`/annotated locals, and React refs. Returns null when
 *  empty so the symbol keeps `paramTypes: null` unless something was found. */
function collectVarTypes(
  paramsNode: SyntaxNode | null,
  bodyNode: SyntaxNode | null,
): Record<string, string> | null {
  const map: Record<string, string> = {};

  if (paramsNode) {
    for (const child of paramsNode.namedChildren) {
      if (
        child.type === 'required_parameter' ||
        child.type === 'optional_parameter'
      ) {
        const nameNode = child.childForFieldName('pattern');
        const typeNode = child.childForFieldName('type');
        if (nameNode && nameNode.type === 'identifier' && typeNode) {
          const refInner = refWrapperInner(typeNode.text);
          if (refInner) map[`${nameNode.text}.current`] = refInner;
          else {
            const t = classNameFromType(typeNode.text);
            if (t) map[nameNode.text] = t;
          }
        }
      }
    }
  }

  if (bodyNode) collectLocalVarTypes(bodyNode, map);

  return Object.keys(map).length > 0 ? map : null;
}

/** Unwrap HOC wrapper calls (`forwardRef`, `memo`, incl. nesting) to the inner
 *  arrow/function that is the real component body, or null if `node` isn't such
 *  a wrapper. */
function unwrapHocFunction(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return node;
  }
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  if (!fn || !HOC_WRAPPERS.has(fn.text)) return null;
  const args = node.childForFieldName('arguments');
  if (!args) return null;
  for (const arg of args.namedChildren) {
    const inner = unwrapHocFunction(arg);
    if (inner) return inner;
  }
  return null;
}
