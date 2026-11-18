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
export function resolvePointer(schema: unknown, rawPointer: string): unknown {
  // Accept a pointer copied with a trailing array marker, as earlier signatures rendered it.
  const pointer = rawPointer.trim().replace(/(\[\])+$/u, '')
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
      // Object alternatives told apart by one constant field: list each branch on its own line,
      // so the model picks the right one without expanding every pointer.
      const listed = branchLines(branches, `${pointer}/${key}`, options, `${indent}  `)
      if (listed !== undefined) {
        lines.push(...listed.lines)
        return `${key}<${listed.lines.length}> by ${listed.discriminator} → ${pointer}/${key}`
      }
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
    if (items === undefined) return 'unknown[]'
    const inner = typeOf(items, `${pointer}/items`, depth, options, lines, indent)
    // Keep exactly one pointer, last and clean: `{…3 fields}[] → /a/items`, never `→ /a/items[]`.
    const arrows = inner.split(' → ').length - 1
    if (arrows === 0) return `${wrap(inner)}[]`
    if (arrows === 1 && !inner.includes(' | ')) {
      const arrow = inner.indexOf(' → ')
      return `${inner.slice(0, arrow)}[]${inner.slice(arrow)}`
    }
    // A union with collapsed branches: point at the item schema as a whole.
    const branches = Array.isArray(items.anyOf) ? items.anyOf.length : Array.isArray(items.oneOf) ? items.oneOf.length : 0
    return `${branches > 0 ? `union<${branches}>` : 'item'}[] → ${pointer}/items`
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

/** The constant value of a discriminator property, when it has exactly one. */
function constantOf(node: JsonSchema | undefined): unknown {
  if (node === undefined) return undefined
  if ('const' in node) return node.const
  if (Array.isArray(node.enum) && node.enum.length === 1) return node.enum[0]
  return undefined
}

/**
 * One line per branch of a discriminated union of objects, or undefined when the branches are
 * not objects sharing a constant-valued property with distinct values.
 */
function branchLines(branches: unknown[], pointer: string, options: CompactOptions, indent: string): { discriminator: string; lines: string[] } | undefined {
  // Nested unions of the same shape are flattened, keeping each branch's exact pointer.
  const flat: Array<{ node: JsonSchema; pointer: string }> = []
  const collect = (list: unknown[], base: string, level: number): boolean => {
    for (const [i, raw] of list.entries()) {
      const node = asSchema(raw)
      if (node === undefined) return false
      const nested = Array.isArray(node.oneOf) ? ['oneOf', node.oneOf] as const : Array.isArray(node.anyOf) ? ['anyOf', node.anyOf] as const : undefined
      if (nested !== undefined && node.properties === undefined) {
        if (level >= 3 || !collect(nested[1], `${base}/${i}/${nested[0]}`, level + 1)) return false
        continue
      }
      if (asSchema(node.properties) === undefined) return false
      flat.push({ node, pointer: `${base}/${i}` })
    }
    return true
  }
  if (branches.length < 2 || !collect(branches, pointer, 0) || flat.length > 40) return undefined
  const first = asSchema(flat[0]!.node.properties)!
  const discriminator = Object.keys(first).find((key) => {
    const values = flat.map(({ node }) => constantOf(asSchema(asSchema(node.properties)![key])))
    return values.every((value) => value !== undefined) && new Set(values.map((value) => JSON.stringify(value))).size >= 2
  })
  if (discriminator === undefined) return undefined
  const lines = flat.map(({ node, pointer: branchPointer }) => {
    const properties = asSchema(node.properties)!
    const required = new Set(Array.isArray(node.required) ? node.required as string[] : [])
    const others = Object.keys(properties).filter((key) => key !== discriminator)
    const fieldsText = others.length === 0 ? '{}' : `{${others.map((key) => {
      const own = constantOf(asSchema(properties[key]))
      return `${key}${required.has(key) ? '' : '?'}${own === undefined ? '' : `=${literal(own)}`}`
    }).join(', ')}}`
    const value = literal(constantOf(asSchema(properties[discriminator])))
    const description = typeof node.description === 'string' ? `  // ${shorten(node.description, options.maxDescription)}` : ''
    return `${indent}| ${discriminator}: ${value} ${fieldsText} → ${branchPointer}${description}`
  })
  return { discriminator, lines }
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
    const arrow = type.lastIndexOf(' → ')
    type = arrow >= 0 ? `${type.slice(0, arrow)}${constraints(node)}${type.slice(arrow)}` : `${type}${constraints(node)}`
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
