/**
 * MCP servers discovered from configuration files.
 *
 * Claude Code, Claude Desktop and Cursor all keep their servers in JSON under `mcpServers`, so a
 * server the user already configured for another tool needs no second entry here. Discovery is
 * additive: an explicit `mcp` entry, or a server contributed by another bundle, always wins a
 * name collision, and only files listed in the config are ever read.
 * @module
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { passesFilter } from './families.js'
import type { McpServerConfig } from './sources/mcp.js'

/** Files scanned when the profile configures none. */
export const DEFAULT_DISCOVERY_FILES: readonly string[] = ['{dshHome}/mcp.json', '{home}/.claude.json', '{home}/.cursor/mcp.json']

/** Largest configuration file that is read at all; bigger files are reported and skipped. */
const MAX_FILE_BYTES = 16 * 1024 * 1024

/** Timeouts a discovered server starts with, matching the schema defaults. */
const DEFAULTS = {
  idleDisconnectMs: 300_000,
  callTimeoutMs: 600_000,
  discoveryTimeoutMs: 60_000,
  catalogTtlMs: 86_400_000,
} as const

/** Discovery settings resolved from the plugin config. */
export interface McpDiscoveryConfig {
  readonly enabled: boolean
  /** Files to read, in order; `~`, `{home}`, `{dshHome}` and `{cwd}` expand. */
  readonly files: readonly string[]
  /** Glob allow list over server names; empty allows all. */
  readonly include: readonly string[]
  /** Glob deny list; wins over {@link include}. */
  readonly deny: readonly string[]
  /** Minimum time between two scans. */
  readonly rescanMs: number
}

/** One server found in a configuration file. */
export interface DiscoveredServer {
  readonly name: string
  /** File the server came from, for logs and problems. */
  readonly origin: string
  readonly config: McpServerConfig
}

/** Result of one scan. */
export interface DiscoveryResult {
  readonly servers: readonly DiscoveredServer[]
  /** Readable notes about files and entries that were skipped. */
  readonly problems: readonly string[]
}

/** Expand tokens and a leading `~`, then resolve a relative path against the working directory. */
export function expandPath(path: string, cwd: string = process.cwd()): string {
  let value = path.trim()
  if (value === '') return ''
  const home = homedir()
  const dshHome = process.env.DSH_HOME?.trim() || join(home, '.dsh')
  value = value.replaceAll('{home}', home).replaceAll('{dshHome}', dshHome).replaceAll('{cwd}', cwd)
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = join(home, value.slice(1))
  return isAbsolute(value) ? value : resolve(cwd, value)
}

/** Turn a configured server key into a catalog server name, or undefined when nothing is left. */
export function serverName(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 32)
  return /^[A-Za-z0-9_-]{1,32}$/u.test(cleaned) ? cleaned : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function textMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === 'string') out[key] = item
  return out
}

/**
 * Read the `mcpServers` map of one parsed configuration file.
 * @param value - parsed JSON of the file.
 * @param origin - file path, used in problems and as the reported origin.
 */
export function parseDiscoveryFile(value: unknown, origin: string): DiscoveryResult {
  const servers: DiscoveredServer[] = []
  const problems: string[] = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${origin}: top level is not a JSON object`)
    return { servers, problems }
  }
  const map = (value as Record<string, unknown>).mcpServers
  if (map === undefined) return { servers, problems }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    problems.push(`${origin}: mcpServers is not an object`)
    return { servers, problems }
  }
  for (const [key, raw] of Object.entries(map as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${origin}: mcpServers.${key} is not an object`)
      continue
    }
    const entry = raw as Record<string, unknown>
    if (entry.disabled === true) continue
    const name = serverName(key)
    if (name === undefined) {
      problems.push(`${origin}: server key "${key}" has no name usable as a catalog key`)
      continue
    }
    const type = (textOf(entry.type) ?? textOf(entry.transport) ?? '').toLowerCase()
    if (type === 'sse') {
      problems.push(`${origin}: "${key}" uses the deprecated sse transport, which this catalog cannot drive; skipped`)
      continue
    }
    const url = textOf(entry.url)
    const command = textOf(entry.command)
    if (url === undefined && command === undefined) {
      problems.push(`${origin}: "${key}" has neither command nor url`)
      continue
    }
    servers.push({
      name,
      origin,
      config: {
        name,
        enabled: true,
        transport: url !== undefined ? 'streamable-http' : 'stdio',
        command,
        args: textList(entry.args),
        env: textMap(entry.env),
        cwd: textOf(entry.cwd),
        url,
        headers: textMap(entry.headers),
        allowTools: [],
        denyTools: [],
        families: [],
        ...DEFAULTS,
      },
    })
  }
  return { servers, problems }
}

/**
 * Scan every configured file. Missing files are not problems; unreadable or malformed ones are
 * reported so a typo in the config is visible instead of silent.
 * @param config - discovery settings.
 * @param options - `cwd` for relative paths and `{cwd}`.
 */
export async function scanMcpConfigFiles(config: McpDiscoveryConfig, options: { cwd?: string } = {}): Promise<DiscoveryResult> {
  const servers: DiscoveredServer[] = []
  const problems: string[] = []
  const seen = new Map<string, string>()
  for (const spec of config.files) {
    const path = expandPath(spec, options.cwd)
    if (path === '') continue
    let body: string
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      if (info.size > MAX_FILE_BYTES) {
        problems.push(`${path}: skipped, ${Math.round(info.size / 1024 / 1024)} MB exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`)
        continue
      }
      body = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') problems.push(`${path}: ${reasonOf(error)}`)
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch (error) {
      problems.push(`${path}: invalid JSON (${reasonOf(error)})`)
      continue
    }
    const found = parseDiscoveryFile(value, path)
    problems.push(...found.problems)
    for (const server of found.servers) {
      if (!passesFilter(server.name, config.include, config.deny)) continue
      const earlier = seen.get(server.name)
      if (earlier !== undefined) {
        problems.push(`${path}: "${server.name}" was already discovered from ${earlier}; kept the first`)
        continue
      }
      seen.set(server.name, path)
      servers.push(server)
    }
  }
  return { servers, problems }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
