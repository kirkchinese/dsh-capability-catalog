# dsh-capability-catalog 设计

2026-10-24，Asia/Tokyo。目标 DSH：0.2.1-rc.2（npm `latest`），兼容范围包含 0.2.1-rc.3。

## 问题

DSH 把每个可见工具的完整 schema 放进每次请求。REA 一个 MCP 服务器就有 207 个工具、约 668 KB 输入 schema，实测首个请求约 25 万输入 token。skill 目录是同一问题的较小版本：82 个 skill 的摘要约 2.8 万字符，且目录任何变化都会整份重新追加。

DSH 现有机制都不解决：官方 `dsh-mcp-client` 直接注册全部工具；PTC/Code Mode 把 schema 换成 SDK 文本，体积不降；会话中途追加工具（`tool_addition`）在 DeepSeek 官方端点上有永久 400 问题。

## 原则

**稳定前缀负责“知道有什么”，工具结果负责“知道怎样调用”，插件负责“是否允许、是否有效、如何执行”。**

1. 模型可见的工具数组固定不变，前缀缓存不失效，不依赖 `tool_addition`。
2. 系统提示词里只放紧凑的分组索引：来源、能力族、条目数、少量代表名。索引内容只随目录内容变化，同一配置下逐字节稳定。
3. 具体条目的说明和参数按需进入工具结果，跟随会话日志，可重放。
4. 一套统一条目模型覆盖所有来源；第一版接入 MCP 工具与 skill，后续接入插件工具、subagent preset 等。

## 统一条目模型

```ts
interface CapabilityEntry {
  id: string            // 全局唯一：<source>:<name>，如 mcp:rea/analyze_javascript_application、skill:tdd
  kind: 'tool' | 'skill'
  source: string        // 'mcp:rea' | 'skills'
  name: string          // 来源内名称
  family: string        // 能力族，用于索引分组与浏览
  summary: string       // 一行摘要（检索与列表）
  description: string   // 完整说明（describe 返回）
  inputSchema?: object  // 工具的原始 JSON Schema，唯一校验依据
  schemaBytes?: number
}
```

来源（`CapabilitySource`）负责发现条目、执行调用、释放资源；目录（`Catalog`）负责合并、分组、检索和渲染索引。

## 模型可见的固定工具

| 工具 | 作用 |
| --- | --- |
| `capability_search` | 按关键词检索（BM25，支持 snake_case 拆词与中文二元组）；`family` 参数可确定性浏览某族全部条目；返回 id、摘要、schema 大小 |
| `capability_describe` | 返回条目的完整说明和参数视图。schema 超过阈值时先给紧凑签名（顶层字段、类型、必填、枚举、约束摘要），用 `path`（JSON Pointer）按需展开子树；skill 返回其完整指令 |
| `capability_call` | 以 id 和 `arguments` 调用工具；先用原始 schema 校验并返回带路径的错误，再转发 MCP，结果按 MCP 内容块渲染 |

可选：接管 skill 目录时，在每个 agent 作用域里隐藏原生 `skill` 工具并注册同名的 scoped `skill` 工具，原生目录因此不再发送，而“调用 skill 工具加载”的既有习惯和 `/name` 手势照常可用。

## MCP 来源

- 每个服务器有 `enabled` 开关；全局也有 `enabled`。关闭时不连接、不进索引，已有连接立即关闭。
- 按需连接：第一次 describe/call 时才启动；空闲 `idleDisconnectMs` 后断开。
- 工具清单缓存到 `$DSH_HOME/capability-catalog/mcp-<server>.json`（键为命令、参数、环境等配置的哈希）。有缓存时启动不必拉起服务器，索引立即可用；后台按 `catalogTtlMs` 刷新。
- `allowTools`/`denyTools` 通配符过滤；`families` 用通配符把工具归入能力族，未配置时按名称自动分组。
- 环境变量沿用 DSH 子进程的凭据清洗（`scrubbedParentEnv`），再叠加显式 `env`。

## skill 来源

- 从 `ctx.skills.snapshot({ scope, cwd })` 读取目录，按名称前缀和后缀自动分组（如 `wiki-*`、`*-history-ingest`）。
- 索引只列族名、数量和名称，不放描述；描述走检索。
- `takeOverSkillCatalog: true` 时启用上面的 scoped `skill` 替换。

## 原生增强模式（预留）

DeepSeek 端点已实测支持：`defer_loading` 工具不计输入 token；客户端搜索工具在结果中返回 `tool_reference` 后，模型可原生调用该工具。DSH 的 DeepSeek 适配器目前不能在工具结果里序列化 `tool_reference`。`mode: native-deferred` 预留给适配器支持之后：工具数组固定为“搜索工具 + 全部延迟工具”，搜索结果附带引用，调用走原生工具名。适配器不支持时自动回退到中转模式。

## 不做

- 不在会话中途改动工具数组，不追加 `tool_addition`。
- 不把 670 KB schema 移进系统提示词。
- 不修改 DSH 源码；上游改进走 Discussion 提案。
