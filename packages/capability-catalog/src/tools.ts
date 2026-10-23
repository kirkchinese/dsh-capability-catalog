/**
 * The fixed model-facing tools: search, describe, call, and the optional skill loader.
 *
 * Their schemas never change while the plugin is loaded, so the provider tool array and
 * its cache prefix stay stable no matter how many capabilities the catalog holds.
 * @module
 */
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import type { Catalog, MetaToolNames } from './catalog.js'
import { compactSignature, resolvePointer } from './schema-view.js'
import type { CallOutcome, CapabilityEntry, ContentBlock, HarnessContext, JsonSchema, SkillDefinitionLike, ToolDefinitionLike, ToolExecutionLike, ViewContext } from './types.js'

/** Limits that shape tool results. */
export interface ToolLimits {
  readonly searchLimit: number
  readonly maxSearchLimit: number
  /** Schemas up to this many bytes are returned verbatim by describe. */
  readonly schemaInlineMaxBytes: number
  /** Upper bound for a compact view before depth is reduced. */
  readonly describeMaxChars: number
  /** Upper bound for rendered call text; longer text is truncated with a notice. */
  readonly callResultMaxChars: number
}

/** Resolves the viewing context of a tool call. */
export type ViewOf = (exec: ToolExecutionLike) => Promise<ViewContext>

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

function kb(bytes: number | undefined): string {
  return bytes === undefined ? '' : bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function resolveEntry(catalog: Catalog, id: string, view: ViewContext): CapabilityEntry {
  const found = catalog.find(id, view)
  if (found === undefined) {
    const disabled = catalog.find(id, view, true)
    if (disabled !== undefined && !('ambiguous' in disabled)) {
      throw new Error(`${disabled.id} is switched off for this session. The user can enable it from the capability controls next to the input box or on the plugin's settings page.`)
    }
    throw new Error(`Unknown capability "${id}". Use capability_search to find the exact id.`)
  }
  if ('ambiguous' in found) throw new Error(`"${id}" matches several capabilities: ${found.ambiguous.map((entry) => entry.id).join(', ')}. Use the full id.`)
  return found
}

/** Render an MCP content array as model text. */
export function renderMcpContent(content: readonly unknown[], structured: unknown, maxChars: number): string {
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as Record<string, unknown>
    switch (item.type) {
      case 'text':
        parts.push(String(item.text ?? ''))
        break
      case 'image':
      case 'audio':
        parts.push(`[${String(item.type)} omitted: ${String(item.mimeType ?? 'unknown type')}]`)
        break
      case 'resource': {
        const resource = (item.resource ?? {}) as Record<string, unknown>
        parts.push(typeof resource.text === 'string' ? resource.text : `[embedded resource ${String(resource.uri ?? '')}]`)
        break
      }
      case 'resource_link':
        parts.push(`[resource ${String(item.name ?? '')}: ${String(item.uri ?? '')}]`)
        break
      default:
        parts.push(JSON.stringify(item))
    }
  }
  if (parts.length === 0 && structured !== undefined) parts.push(JSON.stringify(structured, null, 1))
  const joined = parts.join('\n')
  if (joined.length <= maxChars) return joined
  return `${joined.slice(0, maxChars)}\n…[truncated ${joined.length - maxChars} characters; narrow the request or use paging arguments if the tool offers them]`
}

/** Render a skill exactly as the Harness `skill` tool does. */
export function renderSkillContent(skill: Pick<SkillDefinitionLike, 'name' | 'provider' | 'content' | 'resourceBase'>): string {
  const escapeText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const escapeAttr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  const base = skill.resourceBase as { kind?: string; path?: string; url?: string; description?: string } | undefined
  let hint: string[]
  if (base?.kind === 'directory') hint = [`Base directory for this skill: ${escapeText(String(base.path))}`, 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.']
  else if (base?.kind === 'url') hint = [`Base URL for this skill: ${escapeText(String(base.url))}`, 'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.']
  else if (base?.kind === 'opaque') hint = [`Resources for this skill: ${escapeText(String(base.description))}`, 'Load referenced resources only as needed.']
  else hint = [`Resources for this skill are managed by provider "${escapeText(skill.provider)}".`, 'Load referenced resources only as needed.']
  return [`<skill_content name="${escapeAttr(skill.name)}">`, '<skill_resources>', ...hint, '</skill_resources>', '', '<skill_instructions>', skill.content, '</skill_instructions>', '</skill_content>'].join('\n')
}

/** Argument validation against the raw input schema, compiled once per schema. */
class Validator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
  private readonly cache = new WeakMap<JsonSchema, ValidateFunction | null>()

  errors(schema: JsonSchema | undefined, value: unknown): string[] {
    if (schema === undefined) return []
    let validate = this.cache.get(schema)
    if (validate === undefined) {
      try {
        const { $schema: _ignored, ...rest } = schema
        validate = this.ajv.compile(rest)
      } catch {
        validate = null // The server remains the authority when a schema does not compile here.
      }
      this.cache.set(schema, validate)
    }
    if (validate === null || validate(value)) return []
    return (validate.errors ?? []).slice(0, 12).map((error) => {
      const where = error.instancePath === '' ? '(root)' : error.instancePath
      const extra = error.keyword === 'additionalProperties' ? ` "${String((error.params as { additionalProperty?: string }).additionalProperty)}"`
        : error.keyword === 'enum' ? ` ${JSON.stringify((error.params as { allowedValues?: unknown }).allowedValues)}`
        : ''
      return `${where}: ${error.message ?? error.keyword}${extra}`
    })
  }
}

/**
 * Build the fixed tool set.
 * @param skills - the Harness skill registry, when composed.
 * @param catalog - the merged catalog.
 * @param names - configured tool names.
 * @param limits - result limits.
 * @param viewOf - viewing-context resolver.
 */
export function createTools(skills: HarnessContext['skills'], catalog: Catalog, names: MetaToolNames, limits: ToolLimits, viewOf: ViewOf): { search: ToolDefinitionLike; describe: ToolDefinitionLike; call: ToolDefinitionLike; skill: ToolDefinitionLike } {
  const validator = new Validator()

  const search: ToolDefinitionLike = {
    name: names.search,
    description:
      'Search the capability catalog (tools from connected MCP servers and skills) by keywords, or list one family. ' +
      'Returns ids with one-line summaries; read exact parameters with ' + names.describe + ' before calling.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, an identifier, or a short description of the task. Empty with `family` lists that family.' },
        family: { type: 'string', description: 'Restrict to one family named in the catalog index.' },
        source: { type: 'string', description: 'Restrict to one source, such as "mcp:rea" or "skills".' },
        kind: { type: 'string', enum: ['tool', 'skill'], description: 'Restrict to tools or skills.' },
        limit: { type: 'integer', minimum: 1, maximum: limits.maxSearchLimit, description: `Maximum results; defaults to ${limits.searchLimit}.` },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { results: { type: 'array', items: {} }, families: { type: 'array', items: {} } }, required: ['results'], additionalProperties: false },
      render: (_args, value) => {
        const { results, families } = value as { results: Array<Record<string, unknown>>; families?: string[] }
        if (results.length === 0) {
          return text(`No capability matched.${families && families.length > 0 ? ` Browse a family instead: ${families.join(', ')}.` : ''}`)
        }
        return text(results.map((row) => {
          const size = row.schemaBytes === undefined ? '' : `, params ${kb(row.schemaBytes as number)}`
          return `- ${String(row.id)} [${String(row.kind)}: ${String(row.family)}${size}] ${String(row.summary)}`
        }).join('\n'))
      },
    },
    async execute(args, exec) {
      const input = args as { query?: string; family?: string; source?: string; kind?: string; limit?: number }
      const view = await viewOf(exec)
      const limit = Math.min(input.limit ?? (input.family && !input.query ? limits.maxSearchLimit : limits.searchLimit), limits.maxSearchLimit)
      const hits = catalog.search(input.query ?? '', view, {
        ...input.source ? { source: input.source } : {},
        ...input.family ? { family: input.family } : {},
        ...input.kind ? { kind: input.kind } : {},
      }, limit)
      const results = hits.map(({ entry }) => ({
        id: entry.id,
        kind: entry.kind,
        family: entry.family,
        summary: entry.summary,
        ...entry.schemaBytes === undefined ? {} : { schemaBytes: entry.schemaBytes },
      }))
      if (results.length > 0) return { results }
      const families = [...new Set(catalog.entries(view).filter((entry) => !input.source || entry.source === input.source).map((entry) => `${entry.source}:${entry.family}`))].sort()
      return { results, families }
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => {
      const input = args as { query?: string; family?: string }
      return { card: 'generic', title: `Search capabilities ${input.query ?? input.family ?? ''}`.trim(), kind: 'search', rawInput: input.query ?? input.family ?? '' }
    },
  }

  const describe: ToolDefinitionLike = {
    name: names.describe,
    description:
      'Show one capability in full: its description and exact parameters. Large parameter schemas come back as a compact ' +
      'signature whose collapsed parts name a JSON Pointer; pass that pointer as `path` to expand it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Capability id from the catalog, such as "mcp:rea/analyze_javascript_application" or "skill:tdd".' },
        path: { type: 'string', description: 'JSON Pointer into the input schema, such as "/properties/filters", to expand one part.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => text((value as { text: string }).text),
    },
    async execute(args, exec) {
      const input = args as { id: string; path?: string }
      const view = await viewOf(exec)
      const entry = resolveEntry(catalog, input.id, view)
      if (entry.kind === 'skill') {
        return { text: `${entry.id} (skill, family ${entry.family})\n\n${entry.description}\n\nLoad its full instructions with the \`${names.skill}\` tool: {"name": "${entry.name}"}.` }
      }
      const schema = entry.inputSchema ?? { type: 'object' }
      const lines = [`${entry.id} (tool, family ${entry.family}, params ${kb(entry.schemaBytes)})`, '', entry.description, '']
      if (input.path !== undefined && input.path !== '') {
        const node = resolvePointer(schema, input.path)
        if (node === undefined || node === null || typeof node !== 'object') throw new Error(`Path "${input.path}" does not resolve inside the input schema of ${entry.id}.`)
        const raw = JSON.stringify(node, null, 1)
        if (Buffer.byteLength(raw) <= limits.schemaInlineMaxBytes) lines.push(`Schema at ${input.path} (exact JSON Schema):`, raw)
        else lines.push(`Schema at ${input.path} (compact view):`, fitSignature(entry.name, node as JsonSchema, input.path, limits))
        return { text: lines.join('\n') }
      }
      const raw = JSON.stringify(schema)
      if (Buffer.byteLength(raw) <= limits.schemaInlineMaxBytes) {
        lines.push('Parameters (exact JSON Schema):', JSON.stringify(schema, null, 1))
      } else {
        lines.push(
          'Parameters (compact view of a large schema; `?` marks optional fields, `→ /pointer` marks a collapsed part that `path` expands; the server validates against the full schema):',
          fitSignature(entry.name, schema, '', limits),
        )
      }
      lines.push('', `Run it with ${names.call}: {"id": "${entry.id}", "arguments": {…}}.`)
      return { text: lines.join('\n') }
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Describe ${(args as { id?: string }).id ?? ''}`, kind: 'read', rawInput: (args as { id?: string }).id ?? '' }),
  }

  const call: ToolDefinitionLike = {
    name: names.call,
    description:
      'Run a catalog tool by id with its arguments. Arguments are validated against the tool\'s exact schema first; read it with ' +
      names.describe + ' when unsure.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Capability id of a tool, such as "mcp:rea/analyze_javascript_application".' },
        arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching the tool\'s input schema.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, structuredContent: {} }, required: ['text'], additionalProperties: false },
      render: (_args, value) => text((value as { text: string }).text),
    },
    async execute(args, exec) {
      const input = args as { id: string; arguments?: Record<string, unknown> }
      const view = await viewOf(exec)
      const entry = resolveEntry(catalog, input.id, view)
      if (entry.kind !== 'tool') throw new Error(`${entry.id} is a skill; load it with the \`${names.skill}\` tool instead.`)
      const source = catalog.source(entry.source)
      if (source?.call === undefined) throw new Error(`${entry.id} cannot be called: its source is unavailable.`)
      const argumentsValue = input.arguments ?? {}
      const problems = validator.errors(entry.inputSchema, argumentsValue)
      if (problems.length > 0) {
        throw new Error(`Arguments for ${entry.id} do not match its schema:\n${problems.map((line) => `- ${line}`).join('\n')}\nRead the parameters with ${names.describe} (use \`path\` for nested parts) and retry.`)
      }
      const outcome: CallOutcome = await source.call(entry, argumentsValue, exec.signal)
      const rendered = renderMcpContent(outcome.content, outcome.structuredContent, limits.callResultMaxChars)
      if (outcome.isError) throw new Error(rendered || `${entry.id} reported an error without details.`)
      return { text: rendered === '' ? '(no output)' : rendered }
    },
    isConcurrencySafe: (args) => {
      const id = (args as { id?: string }).id
      if (typeof id !== 'string') return false
      const found = catalog.find(id, {})
      return found !== undefined && !('ambiguous' in found) && found.readOnly === true
    },
    presentCall: (args) => {
      const input = args as { id?: string; arguments?: unknown }
      return { card: 'generic', title: `Run ${input.id ?? ''}`, kind: 'execute', rawInput: JSON.stringify(input.arguments ?? {}) }
    },
  }

  const skill: ToolDefinitionLike = {
    name: names.skill,
    description:
      'Load a skill\'s full instructions by exact name. Skill names are listed in the capability catalog; ' +
      `${names.search} with kind "skill" returns their descriptions.`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact skill name.' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { name: { type: 'string' }, provider: { type: 'string' }, resourceBase: {}, content: { type: 'string' } }, required: ['name', 'provider', 'content'], additionalProperties: false },
      render: (_args, value) => text(renderSkillContent(value as SkillDefinitionLike)),
    },
    async execute(args, exec) {
      const name = (args as { name: string }).name
      if (skills === undefined) throw new Error('Skills are not available in this composition.')
      const view = await viewOf(exec)
      const lookup = { ...view.scope ? { scope: view.scope } : {}, ...view.cwd ? { cwd: view.cwd } : {}, signal: exec.signal }
      const entry = catalog.find(`skill:${name}`, view, true)
      if (entry !== undefined && !('ambiguous' in entry) && !catalog.isEnabled(entry, view)) {
        throw new Error(`skill "${name}" is switched off for this session. The user can enable it from the capability controls next to the input box.`)
      }
      const definition = await skills.get(name, lookup)
      if (definition === undefined) throw new Error(`skill "${name}" is unknown or no longer available`)
      if (!definition.invocation.modelInvocable) throw new Error(`skill "${name}" is not available for model invocation`)
      return {
        name: definition.name,
        provider: definition.provider,
        ...definition.resourceBase !== undefined ? { resourceBase: { ...definition.resourceBase } } : {},
        content: definition.content,
      }
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Load skill ${(args as { name?: string }).name ?? ''}`, kind: 'read', rawInput: (args as { name?: string }).name ?? '' }),
  }

  return { search, describe, call, skill }
}

/** Render a compact signature, reducing depth until it fits the describe budget. */
function fitSignature(name: string, schema: JsonSchema, pointer: string, limits: ToolLimits): string {
  for (const maxDepth of [3, 2, 1]) {
    const signature = compactSignature(name, schema, pointer, { maxDepth, maxDescription: maxDepth >= 2 ? 160 : 100 })
    if (signature.length <= limits.describeMaxChars || maxDepth === 1) {
      return signature.length <= limits.describeMaxChars ? signature : `${signature.slice(0, limits.describeMaxChars)}\n…[signature truncated; expand parts with path]`
    }
  }
  return ''
}
