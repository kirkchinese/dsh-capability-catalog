#!/usr/bin/env node
// Minimal newline-delimited JSON-RPC MCP server for tests.
// Appends one line per process start to $FAKE_MCP_STARTS so tests can count launches.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.env.FAKE_MCP_STARTS) appendFileSync(process.env.FAKE_MCP_STARTS, `${process.pid}\n`)
// FAKE_MCP_HANG=1 never answers, to exercise handshake timeouts.
const hang = process.env.FAKE_MCP_HANG === '1'

const tools = [
  {
    name: 'echo_text',
    description: 'Echo the given text back. Useful for testing.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: { 'example.org/fake': { family: 'echo' } },
  },
  {
    name: 'inspect_widget_config',
    description: 'Inspect a widget configuration file and report its sections.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['path'] },
  },
  {
    name: 'fail_always',
    description: 'Always returns an MCP error result.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined || hang) return
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
        instructions: 'Fake server for capability-catalog tests.',
      } })
      break
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools } })
      break
    case 'tools/call': {
      const { name, arguments: args } = message.params
      if (name === 'fail_always') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
      else send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] } })
      break
    }
    case 'ping':
      send({ jsonrpc: '2.0', id: message.id, result: {} })
      break
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
  }
})
