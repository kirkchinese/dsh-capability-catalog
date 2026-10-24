import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import { Catalog, compactSignature, resolvePointer, tokenize } from '../lib/index.js'
import { summarize, summarizeFamilies } from '../lib/catalog.js'
import { assignFamilies, passesFilter } from '../lib/families.js'
import { McpSource } from '../lib/sources/mcp.js'
import { skillFamilies, SkillSource } from '../lib/sources/skills.js'
import { createTools, renderMcpContent } from '../lib/tools.js'
import { ToggleStore } from '../lib/toggles.js'

const here = dirname(fileURLToPath(import.meta.url))
const reaTools = JSON.parse(gunzipSync(readFileSync(join(here, 'fixtures/rea-6.7.0-tools.json.gz'))).toString('utf8'))
const NAMES = { search: 'capability_search', describe: 'capability_describe', call: 'capability_call', skill: 'skill' }
const LIMITS = { searchLimit: 8, maxSearchLimit: 60, schemaInlineMaxBytes: 6000, describeMaxChars: 14000, callResultMaxChars: 120000 }
const quiet = { info() {}, warn() {}, debug() {} }

function reaEntries(rules = []) {
  const { family } = assignFamilies(reaTools.map((tool) => tool.name), rules)
  return reaTools.map((tool) => ({
    id: `mcp:rea/${tool.name}`, kind: 'tool', source: 'mcp:rea', name: tool.name, family: family.get(tool.name),
    summary: summarize(tool.description ?? ''), description: tool.description ?? '', inputSchema: tool.inputSchema,
    schemaBytes: Buffer.byteLength(JSON.stringify(tool.inputSchema)),
  }))
}

function reaCatalog() {
  const entries = reaEntries()
  const catalog = new Catalog()
  catalog.add({
    key: 'mcp:rea',
    entries: () => entries,
    index: (_view, list) => ({ source: 'mcp:rea', title: 'mcp:rea — REA', total: list.length, families: summarizeFamilies(list) }),
    call: async (entry, args) => ({ content: [{ type: 'text', text: `${entry.name} ${JSON.stringify(args)}` }] }),
  })
  return catalog
}

const exec = (args) => ({ callId: 'c1', name: 'x', arguments: args, signal: AbortSignal.timeout(10_000) })
const view = async () => ({})

test('tokenize splits identifiers and indexes CJK bigrams', () => {
  assert.deepEqual(tokenize('analyze_javascript_application'), ['analyze', 'javascript', 'applic'])
  assert.deepEqual(tokenize('applications'), tokenize('application'), 'light stemming joins inflections')
  assert.deepEqual(tokenize('inspectAndroidClass'), ['inspect', 'android', 'class'])
  assert.deepEqual(tokenize('逆向分析'), ['逆向', '向分', '分析'])
})

test('search ranks the expected REA tools first', () => {
  const catalog = reaCatalog()
  const top = (query) => catalog.search(query, {}, {}, 3).map((hit) => hit.entry.name)
  assert.equal(top('analyze javascript electron app modules')[0], 'analyze_javascript_application')
  assert.equal(top('android apk classes')[0], 'search_android_classes')
  assert.equal(top('sqlite database tables')[0], 'inspect_sqlite_database')
  assert.equal(top('har network capture')[0], 'inspect_web_network_capture')
  assert.equal(top('procedure_pseudo_code')[0], 'procedure_pseudo_code', 'an exact name wins')
})

test('family browsing lists one family deterministically', () => {
  const catalog = reaCatalog()
  const hits = catalog.search('', {}, { family: 'frida' }, 60)
  assert.ok(hits.length >= 5)
  assert.ok(hits.every((hit) => hit.entry.family === 'frida'))
})

test('the standing index stays small and byte-stable', () => {
  const catalog = reaCatalog()
  const first = catalog.renderIndex({}, NAMES, true)
  const second = catalog.renderIndex({}, NAMES, true)
  assert.equal(first, second)
  assert.ok(first.length < 4000, `index has ${first.length} characters`)
  assert.match(first, /mcp:rea — REA \(207\)/u)
  assert.match(first, /replaces the separate skill list/u, 'takeover text overrides the native empty-catalog reminder')
  assert.doesNotMatch(catalog.renderIndex({}, NAMES, false), /replaces the separate skill list/u)
  const total = reaTools.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema).length, 0)
  assert.ok(total / first.length > 150, 'index is two orders of magnitude smaller than the schemas')
})

test('compact signatures collapse large schemas behind resolvable pointers', () => {
  const tool = reaTools.find((candidate) => candidate.name === 'compare_web_captures')
  const signature = compactSignature(tool.name, tool.inputSchema, '', { maxDepth: 2 })
  assert.ok(JSON.stringify(tool.inputSchema).length > 100_000)
  assert.ok(signature.length < 6000, `signature has ${signature.length} characters`)
  const pointers = [...signature.matchAll(/→ (\/\S+)/gu)].map((match) => match[1])
  assert.ok(pointers.every((pointer) => !pointer.endsWith('[]')), 'pointers carry no array marker')
  assert.ok(pointers.length > 0)
  for (const pointer of pointers) assert.notEqual(resolvePointer(tool.inputSchema, pointer), undefined, pointer)
  assert.notEqual(resolvePointer(tool.inputSchema, `${pointers[0]}[]`), undefined, 'a trailing [] is tolerated')
})

test('compact signatures keep required markers, enums and defaults', () => {
  const signature = compactSignature('t', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Input path.' }, mode: { enum: ['a', 'b'], default: 'a' }, depth: { type: 'integer', minimum: 1, maximum: 5 } },
    required: ['path'],
  })
  assert.match(signature, /^ {2}path: string {2}\/\/ Input path\.$/mu)
  assert.match(signature, /mode\?: "a" \| "b" = "a"/u)
  assert.match(signature, /depth\?: integer \(1\.\.5\)/u)
})

test('heuristic families keep REA tools grouped', () => {
  const entries = reaEntries()
  const byFamily = Map.groupBy(entries, (entry) => entry.family)
  assert.ok(byFamily.get('javascript').some((entry) => entry.name === 'analyze_javascript_application'))
  assert.ok(byFamily.get('adb').length >= 20)
  for (const [name, members] of byFamily) if (name !== 'misc') assert.ok(members.length >= 3, `${name} has ${members.length}`)
})

test('curated rules win over the heuristic', () => {
  const { family, descriptions } = assignFamilies(['inspect_go_binary', 'inspect_rust_binary', 'list_adb_devices'], [{ name: 'toolchains', description: 'Go and Rust metadata', match: ['inspect_go_*', 'inspect_rust_*'] }])
  assert.equal(family.get('inspect_go_binary'), 'toolchains')
  assert.equal(family.get('inspect_rust_binary'), 'toolchains')
  assert.equal(descriptions.get('toolchains'), 'Go and Rust metadata')
})

test('allow and deny filters use globs and deny wins', () => {
  assert.equal(passesFilter('push_adb_file', [], ['*_adb_*']), false)
  assert.equal(passesFilter('list_adb_devices', ['list_*'], []), true)
  assert.equal(passesFilter('inspect_go_binary', ['list_*'], []), false)
  assert.equal(passesFilter('list_adb_devices', ['list_*'], ['*adb*']), false)
})

test('skill families group shared prefixes and suffixes', () => {
  const families = skillFamilies(['wiki-query', 'wiki-lint', 'wiki-setup', 'claude-history-ingest', 'codex-history-ingest', 'pi-history-ingest', 'tdd', 'pr'])
  assert.equal(families.get('wiki-lint'), 'wiki')
  assert.equal(families.get('codex-history-ingest'), 'history-ingest')
  assert.equal(families.get('tdd'), 'general')
})

test('skill source indexes names with brief descriptions and refreshes per scope', async () => {
  const skills = [
    { name: 'tdd', description: 'Test-driven development. Use when building features test-first.', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-agents', provider: 'fs' },
    { name: 'hidden', description: 'Not for models.', invocation: { modelInvocable: false, userInvocable: true }, source: 'user-agents', provider: 'fs' },
  ]
  const source = new SkillSource({ snapshot: async () => ({ skills, complete: true }) }, { indexMode: 'brief', briefChars: 80, families: [], allow: [], deny: [] })
  const scope = {}
  await source.refresh({ scope }, AbortSignal.timeout(1000))
  assert.deepEqual(source.entries({ scope }).map((entry) => entry.id), ['skill:tdd'])
  const index = source.index({ scope }, source.entries({ scope }))
  assert.equal(index.total, 1)
  assert.equal(index.families[0].members[0].brief, 'Test-driven development.')
})

test('call validates arguments against the raw schema before dispatch', async () => {
  const catalog = reaCatalog()
  const { call } = createTools(undefined, catalog, NAMES, LIMITS, view)
  await assert.rejects(
    call.execute({ id: 'mcp:rea/analyze_javascript_application', arguments: { format: 'zip' } }, exec()),
    (error) => /input_path/u.test(error.message) && /must be equal to one of the allowed values/u.test(error.message),
  )
  const ok = await call.execute({ id: 'analyze_javascript_application', arguments: { input_path: '/tmp/app' } }, exec())
  assert.match(ok.text, /analyze_javascript_application \{"input_path":"\/tmp\/app"\}/u)
})

test('describe returns exact small schemas and compact large ones', async () => {
  const catalog = reaCatalog()
  const { describe } = createTools(undefined, catalog, NAMES, LIMITS, view)
  const small = await describe.execute({ id: 'mcp:rea/inspect_sqlite_database' }, exec())
  const large = await describe.execute({ id: 'mcp:rea/compare_web_captures' }, exec())
  assert.match(large.text, /compact view/u)
  assert.ok(large.text.length < LIMITS.describeMaxChars + 2000)
  const expanded = await describe.execute({ id: 'mcp:rea/compare_web_captures', path: '/properties/normalization' }, exec())
  assert.match(expanded.text, /Schema at \/properties\/normalization/u)
  assert.ok(small.text.length > 0)
  await assert.rejects(describe.execute({ id: 'mcp:rea/compare_web_captures', path: '/nope' }, exec()), /does not resolve/u)
})

test('unknown and ambiguous ids explain how to recover', async () => {
  const catalog = new Catalog()
  const entry = (source) => ({ id: `${source}/same`, kind: 'tool', source, name: 'same', family: 'x', summary: '', description: '' })
  catalog.add({ key: 'mcp:a', entries: () => [entry('mcp:a')], index: () => undefined })
  catalog.add({ key: 'mcp:b', entries: () => [entry('mcp:b')], index: () => undefined })
  const { describe } = createTools(undefined, catalog, NAMES, LIMITS, view)
  await assert.rejects(describe.execute({ id: 'same' }, exec()), /mcp:a\/same, mcp:b\/same/u)
  await assert.rejects(describe.execute({ id: 'nothing' }, exec()), /capability_search/u)
})

test('MCP content renders text, elides media, and truncates', () => {
  const text = renderMcpContent([{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: 'x' }], undefined, 1000)
  assert.equal(text, 'hello\n[image omitted: image/png]')
  assert.match(renderMcpContent([{ type: 'text', text: 'x'.repeat(50) }], undefined, 10), /truncated 40 characters/u)
  assert.equal(renderMcpContent([], { a: 1 }, 100), '{\n "a": 1\n}')
})

test('MCP source discovers, caches, connects lazily and disconnects when idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capability-catalog-'))
  const starts = join(dir, 'starts')
  const config = {
    name: 'fake', enabled: true, transport: 'stdio', command: process.execPath, args: [join(here, 'fixtures/fake-mcp-server.mjs')],
    env: { FAKE_MCP_STARTS: starts }, headers: {}, allowTools: [], denyTools: ['fail_*'], families: [],
    idleDisconnectMs: 1000, callTimeoutMs: 5000, discoveryTimeoutMs: 10_000, catalogTtlMs: 1e9,
  }
  const first = new McpSource(config, dir, quiet)
  await first.start()
  assert.deepEqual(first.entries().map((entry) => entry.id), ['mcp:fake/echo_text', 'mcp:fake/inspect_widget_config'])
  assert.equal(first.entries()[0].readOnly, true)
  assert.equal(first.entries()[0].family, 'echo', 'a family declared in _meta is used')
  assert.equal(first.connected, false, 'startup discovery closes its connection')
  assert.ok(existsSync(join(dir, 'mcp-fake.json')))
  const outcome = await first.call(first.entries()[0], { text: 'hi' }, AbortSignal.timeout(5000))
  assert.deepEqual(outcome.content, [{ type: 'text', text: 'echo_text:{"text":"hi"}' }])
  assert.equal(first.connected, true)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(first.connected, false, 'idle connection closes')
  await first.dispose()

  const second = new McpSource(config, dir, quiet)
  await second.start()
  assert.equal(second.entries().length, 2, 'cached catalog is reused')
  await second.dispose()
  assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 2, 'only discovery and the call started a process')
})

test('toggles resolve session over global over configured defaults and persist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capability-toggles-'))
  const path = join(dir, 'toggles.json')
  const store = new ToggleStore(path)
  await store.load()
  assert.equal(store.enabled('skill', 'tdd', 's1'), true)
  assert.equal(store.enabled('server', 'rea', 's1', false), false, 'configured default applies')
  await store.set('global', 'skill', 'tdd', false)
  assert.equal(store.enabled('skill', 'tdd', 's1'), false)
  await store.set({ sessionId: 's1' }, 'skill', 'tdd', true)
  assert.equal(store.enabled('skill', 'tdd', 's1'), true, 'session override wins')
  assert.equal(store.enabled('skill', 'tdd', 's2'), false, 'other sessions keep the global value')
  const reloaded = new ToggleStore(path)
  await reloaded.load()
  assert.equal(reloaded.enabled('skill', 'tdd', 's1'), true)
  await reloaded.set({ sessionId: 's1' }, 'skill', 'tdd', null)
  assert.equal(reloaded.session('s1'), undefined, 'empty session layers are dropped')
})

test('switched-off capabilities leave the index, search and calls', async () => {
  const catalog = reaCatalog()
  const off = new Set(['mcp:rea/inspect_sqlite_database'])
  catalog.isEnabled = (entry, view) => !(view.sessionId === 's1' && off.has(entry.id))
  assert.equal(catalog.search('sqlite database tables', { sessionId: 's1' }, {}, 3)[0]?.entry.name === 'inspect_sqlite_database', false)
  assert.equal(catalog.search('sqlite database tables', { sessionId: 's2' }, {}, 3)[0].entry.name, 'inspect_sqlite_database')
  assert.match(catalog.renderIndex({ sessionId: 's1' }, NAMES, true), /\(206\)/u)
  const { call } = createTools(undefined, catalog, NAMES, LIMITS, async () => ({ sessionId: 's1' }))
  await assert.rejects(call.execute({ id: 'mcp:rea/inspect_sqlite_database', arguments: { path: '/x' } }, exec()), /switched off/u)
})

const fakeConfig = (dir, extra = {}) => ({
  name: 'fake', enabled: true, transport: 'stdio', command: process.execPath, args: [join(here, 'fixtures/fake-mcp-server.mjs')],
  env: { FAKE_MCP_STARTS: join(dir, 'starts') }, headers: {}, allowTools: [], denyTools: [], families: [],
  idleDisconnectMs: 1000, callTimeoutMs: 5000, discoveryTimeoutMs: 10_000, catalogTtlMs: 1e9, ...extra,
})

test('a server that did not start globally is discovered on demand for a session that wants it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capability-ondemand-'))
  const source = new McpSource(fakeConfig(dir), dir, quiet)
  source.isWanted = (view) => view.sessionId === 'wanted'
  await source.start({ discover: false })
  assert.equal(source.entries().length, 0)
  await source.refresh({ sessionId: 'other' })
  assert.equal(source.entries().length, 0, 'other sessions do not trigger discovery')
  await source.refresh({ sessionId: 'wanted' })
  assert.equal(source.entries().length, 3)
  await source.dispose()
})

test('a handshake timeout closes the child process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capability-timeout-'))
  const config = fakeConfig(dir, { env: { FAKE_MCP_STARTS: join(dir, 'starts'), FAKE_MCP_HANG: '1' }, discoveryTimeoutMs: 1000 })
  const source = new McpSource(config, dir, quiet)
  await source.start()
  assert.match(source.problem ?? '', /timed out/u)
  const pid = Number(readFileSync(join(dir, 'starts'), 'utf8').trim())
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.throws(() => process.kill(pid, 0), 'the timed-out server process is gone')
  await source.dispose()
})

test('a switched-off source leaves the index even when it reports a problem', () => {
  const catalog = new Catalog()
  catalog.add({ key: 'mcp:broken', entries: () => [], index: () => ({ source: 'mcp:broken', title: 'mcp:broken', total: 0, families: [], note: 'discovery failed' }) })
  assert.match(catalog.renderIndex({}, NAMES, false), /discovery failed/u)
  catalog.isSourceEnabled = (source) => source.key !== 'mcp:broken'
  assert.equal(catalog.renderIndex({}, NAMES, false), '')
})

test('every pointer in every REA signature resolves, at every depth', () => {
  const failures = []
  for (const tool of reaTools) {
    for (const maxDepth of [1, 2, 3]) {
      const signature = compactSignature(tool.name, tool.inputSchema, '', { maxDepth })
      for (const match of signature.matchAll(/→ (\S+)/gu)) {
        const pointer = match[1]
        if (!/^\/[^\s\[\])]*$/u.test(pointer) || resolvePointer(tool.inputSchema, pointer) === undefined) failures.push(`${tool.name}@${maxDepth}: ${pointer}`)
      }
    }
  }
  assert.deepEqual(failures.slice(0, 10), [])
})
