/**
 * Model-facing views of large JSON Schemas.
 *
 * A selected tool can still carry a 100 KB+ input schema. The raw schema stays the only
 * validation authority; this module derives a compact signature that keeps names, types,
 * required markers, enums, defaults and short descriptions, collapses deep subtrees behind
 * JSON Pointers, and resolves a pointer back to a subtree on request.
 * @module
 */
import type { JsonSchema } from './types.js'

/** Options for {@link compactSignature}. */
export interface CompactOptions {
  /** Object nesting rendered inline before collapsing. */
  readonly maxDepth: number
  /** Description characters kept per field. */
  readonly maxDescription: number
  /** Enum values listed before eliding. */
  readonly maxEnum: number
}

const DEFAULT_OPTIONS: CompactOptions = { maxDepth: 2, maxDescription: 160, maxEnum: 12 }

/**
 * Resolve an RFC 6901 JSON Pointer inside a schema.
 * @param schema - root schema.
 * @param pointer - pointer such as `/properties/filters`; empty means the root.
 * @returns the subtree, or undefined when the pointer does not resolve.
 */
export function resolvePointer(schema: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return schema
  if (!pointer.startsWith('/')) return undefined
  let node: unknown = schema
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (Array.isArray(node)) node = node[Number(key)]
    else if (node !== null && typeof node === 'object') node = (node as Record<string, unknown>)[key]
    else return undefined
    if (node === undefined) return undefined
  }
  return node
}

function escapePointer(key: string): string {
  return key.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function literal(value: unknown): string {
  const text = JSON.stringify(value)
  return text === undefined ? String(value) : text
}

function asSchema(value: unknown): JsonSchema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchema : undefined
}

/** Render a short constraint suffix such as `(1..100, pattern)`. */
function constraints(schema: JsonSchema): string {
  const parts: string[] = []
  const min = schema.minimum ?? schema.exclusiveMinimum
  const max = schema.maximum ?? schema.exclusiveMaximum
  if (min !== undefined || max !== undefined) parts.push(`${min ?? ''}..${max ?? ''}`)
  if (schema.minLength !== undefined || schema.maxLength !== undefined) parts.push(`len ${schema.minLength ?? 0}..${schema.maxLength ?? ''}`)
  if (schema.minItems !== undefined || schema.maxItems !== undefined) parts.push(`items ${schema.minItems ?? 0}..${schema.maxItems ?? ''}`)
  if (schema.minProperties !== undefined) parts.push(`min ${String(schema.minProperties)} props`)
  if (typeof schema.pattern === 'string') parts.push('pattern')
  if (typeof schema.format === 'string') parts.push(schema.format)
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/**
 * Render a one-line type expression for a schema.
 * @param schema - schema node.
 * @param pointer - pointer of this node, used in collapse hints.
 * @param depth - remaining inline object depth.
 * @param options - rendering limits.
 * @param lines - output buffer for nested object fields.
 * @param indent - indentation of nested fields.
 */
function typeOf(schema: JsonSchema, pointer: string, depth: number, options: CompactOptions, lines: string[], indent: string): string {
  if ('const' in schema) return literal(schema.const)
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, options.maxEnum).map(literal)
    if (schema.enum.length > options.maxEnum) values.push(`…+${schema.enum.length - options.maxEnum}`)
    return values.join(' | ')
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = schema[key]
    if (Array.isArray(branches)) {
      if (branches.length > 4 || depth <= 0) return `${key}<${branches.length} branches> → ${pointer}/${key}`
      return branches
        .map((branch, i) => {
          const node = asSchema(branch)
          // Object branches collapse to a pointer so alternatives stay on one line.
          return node === undefined ? 'unknown' : typeOf(node, `${pointer}/${key}/${i}`, 0, options, lines, indent)
        })
        .join(' | ')
    }
  }
  if (Array.isArray(schema.allOf)) return `allOf<${schema.allOf.length}> → ${pointer}/allOf`
  if (typeof schema.$ref === 'string') return `ref(${schema.$ref})`
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type
  if (type === 'array') {
    const items = asSchema(schema.items)
    return items === undefined ? 'unknown[]' : `${wrap(typeOf(items, `${pointer}/items`, depth, options, lines, indent))}[]`
  }
  if (type === 'object' || schema.properties !== undefined) {
    const properties = asSchema(schema.properties)
    const count = properties === undefined ? 0 : Object.keys(properties).length
    if (count === 0) return schema.additionalProperties === false ? '{}' : 'object'
    if (depth <= 0) return `{…${count} fields} → ${pointer}`
    fields(schema, pointer, depth - 1, options, lines, `${indent}  `)
    return '{'
  }
  return typeof type === 'string' ? type : 'unknown'
}

function wrap(text: string): string {
  return text.includes(' | ') ? `(${text})` : text
}

/** Append one line per property of an object schema. */
function fields(schema: JsonSchema, pointer: string, depth: number, options: CompactOptions, lines: string[], indent: string): void {
  const properties = asSchema(schema.properties) ?? {}
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : [])
  for (const [key, value] of Object.entries(properties)) {
    const node = asSchema(value) ?? {}
    const childPointer = `${pointer}/properties/${escapePointer(key)}`
    const nested: string[] = []
    let type = typeOf(node, childPointer, depth, options, nested, indent)
    const opensObject = type === '{'
    const optional = required.has(key) ? '' : '?'
    const defaultText = 'default' in node ? ` = ${literal(node.default)}` : ''
    const description = typeof node.description === 'string' ? `  // ${shorten(node.description, options.maxDescription)}` : ''
    if (opensObject) {
      lines.push(`${indent}${key}${optional}: {${constraints(node)}${description}`)
      lines.push(...nested)
      lines.push(`${indent}}`)
      continue
    }
    type = `${type}${constraints(node)}`
    lines.push(`${indent}${key}${optional}: ${type}${defaultText}${description}`)
    lines.push(...nested)
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) lines.push(`${indent}[key: string]: unknown`)
}

/**
 * Derive a compact, TypeScript-like signature from an object schema.
 * @param name - tool name used as the signature head.
 * @param schema - input schema or a subtree.
 * @param pointer - pointer of `schema` inside the full input schema.
 * @param options - rendering limits.
 * @returns signature text; collapsed subtrees name the pointer that expands them.
 */
export function compactSignature(name: string, schema: JsonSchema, pointer = '', options: Partial<CompactOptions> = {}): string {
  const resolved = { ...DEFAULT_OPTIONS, ...options }
  const lines: string[] = []
  const isObject = schema.type === 'object' || schema.properties !== undefined
  if (!isObject) {
    lines.push(`${name}: ${typeOf(schema, pointer, resolved.maxDepth, resolved, lines, '  ')}`)
    return lines.join('\n')
  }
  lines.push(`${name}({${constraints(schema)}`)
  fields(schema, pointer, resolved.maxDepth - 1, resolved, lines, '  ')
  lines.push('})')
  return lines.join('\n')
}

/** Drop annotation-only keywords that do not change validation. */
export function stripAnnotations(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripAnnotations)
  if (schema === null || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'examples' || key === '$schema' || key === '$comment') continue
    out[key] = key === 'properties' && value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripAnnotations(v)]))
      : stripAnnotations(value)
  }
  return out
}
