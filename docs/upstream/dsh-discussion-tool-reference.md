# Draft: DeepSeek Harness Discussion

Category: Ideas / Feature request. Status: draft, not posted.

---

**Title:** DeepSeek adapter: let tool results carry `tool_reference` so large MCP catalogs can stay deferred (the official endpoint already supports it)

## Problem

`dsh-mcp-client` registers every discovered MCP tool, and the registry sends every visible schema with every request. Large servers make this expensive. REA 6.7.0, which lists DeepSeek Harness as a supported client, exposes 207 tools with about 668 KB of input schemas. With REA registered through `dsh-mcp-client` on 0.2.0-rc.2, the first request of a headless session reported **249,653 input tokens**, and every later step repeated that prefix (cache hits keep the cost down, not the context use).

PTC mode does not help here: its SDK text replaces the schemas at a comparable size, as the `dsh-tools` README notes. Mid-conversation registration (`tool_addition`) is the mechanism meant for growing tool sets, but it currently breaks sessions on the official endpoint (#10539, #10547, #10553, #10563).

## What the official endpoint already accepts

Measured on 2026-10-23 against `https://api.deepseek.com/anthropic/v1/messages` with `deepseek-flash` and `deepseek-v4-pro`:

| Request | Result |
| --- | --- |
| `tools` with `tool_search_tool_bm25_20251119` or `_regex_` | 422, unknown variant (server-side tool search is not offered) |
| every tool `defer_loading: true` | 400, "at least one tool must have defer_loading=false" |
| 1 regular tool + 150 large tools with `defer_loading: true` | `input_tokens` 166, identical to the regular tool alone; the same 150 tools without the flag: 261,938 |
| a client-side `tool_search` tool whose `tool_result.content` is `[{"type": "tool_reference", "tool_name": "<deferred tool>"}]` | 200; on the next turn both models emit an ordinary `tool_use` for the referenced deferred tool with correct arguments |

So the endpoint supports the client-side tool search pattern: deferred tools cost nothing until referenced, the tools array never changes, no `tool_addition` block is involved, and the prompt cache prefix stays stable. A minimal script that reproduces the table is attached below.

## What is missing in the Harness

- `ToolSchema.deferLoading` already serializes to `defer_loading`, but a deferred tool only activates through a `tool-addition` developer message.
- Tool result content cannot express a tool reference: `WireInput` in `dsh-llm-deepseek` allows text and images only, and there is no harness content block that maps to `tool_reference` (checked on 0.2.0-rc.2 and master 687f282e86).
- `dsh-mcp-client` has no option to register discovered tools as deferred.

## Proposal

1. A harness content block for tool results, for example `{ type: 'tool-reference', toolName }`, logged like any other result content so replay stays exact, and serialized by the DeepSeek Messages adapter to `{ type: 'tool_reference', tool_name }` inside `tool_result.content`. Routes that cannot carry it could project it to text, as image blocks are projected for text-only routes.
2. A route capability flag (similar to `toolUpdate`) so the registry or a plugin knows whether references are supported.
3. An opt-in `deferLoading: true` on `dsh-mcp-client` rows, plus a small search tool (built in or in a plugin) that returns references.

This keeps the tool array fixed for the whole session, which also sidesteps the permanent-400 failure mode of mid-conversation tool changes.

## Workaround we use today

A plugin that never changes the tools array: a compact family index in the system prompt plus fixed `capability_search` / `capability_describe` / `capability_call` tools that proxy MCP calls and validate arguments against the original schema. With REA behind it, the first request of the same headless task reported about 9.2k input tokens instead of 249,653, and the task completed. It works today but costs an extra step per tool and loses native tool calls, which is why native references would be better.

## Reproduction script

```python
# Requires DEEPSEEK_API_KEY. Prints the four rows of the table above.
import json, os, urllib.request

def call(body):
    req = urllib.request.Request(
        'https://api.deepseek.com/anthropic/v1/messages', json.dumps(body).encode(),
        {'x-api-key': os.environ['DEEPSEEK_API_KEY'], 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as error:
        return {'status': error.code, 'body': error.read().decode()[:300]}

def tool(name, deferred=True):
    t = {'name': name, 'description': f'{name} tool', 'input_schema': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path']}}
    if deferred:
        t['defer_loading'] = True
    return t

search = {'name': 'tool_search', 'description': 'Search deferred tools; returns tool references.',
          'input_schema': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}}
tools = [search, tool('analyze_javascript_application'), tool('inspect_sqlite_database')]
messages = [{'role': 'user', 'content': 'Find the right tool and analyze the JavaScript app at /tmp/app.'}]
first = call({'model': 'deepseek-flash', 'max_tokens': 800, 'messages': messages, 'tools': tools})
uses = [block for block in first['content'] if block['type'] == 'tool_use']
messages += [{'role': 'assistant', 'content': first['content']},
             {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': use['id'],
                                           'content': [{'type': 'tool_reference', 'tool_name': 'analyze_javascript_application'}]} for use in uses]}]
second = call({'model': 'deepseek-flash', 'max_tokens': 800, 'messages': messages, 'tools': tools})
print([block for block in second['content'] if block['type'] == 'tool_use'])
```
