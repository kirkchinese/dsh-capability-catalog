# @kirkchinese/dsh-capability-catalog

DeepSeek Harness 的统一能力目录：一份紧凑索引加三个固定工具，按需提供 MCP 工具与 skill。

Lazy capability catalog for DeepSeek Harness: one compact index plus three fixed tools serve MCP tools and skills on demand, instead of every schema on every request.

## 模型看到什么

- 系统提示词中的 `## Capability catalog` 段：每个来源的能力族、数量和代表名称；skill 列出名称与短描述。
- 固定工具：

| 工具 | 作用 |
| --- | --- |
| `capability_search` | 关键词检索（BM25，拆分 snake_case），或用 `family` 浏览一族；可按 `source`、`kind` 过滤 |
| `capability_describe` | 完整说明与参数。schema 不超过 `schemaInlineMaxBytes` 时原样返回，否则返回紧凑签名，折叠处标出 JSON Pointer，用 `path` 展开 |
| `capability_call` | 用原始 schema 校验参数（错误带字段路径），再调用 MCP |
| `skill`（接管时） | 按名称加载 skill，输出与原生 `skill` 工具一致 |

工具列表在会话中不变；索引只随目录内容变化，同一配置下逐字节稳定。

## 配置

```yaml
- id: capability-catalog
  config:
    enabled: true                 # 总开关
    mcp:
      - name: rea                 # 条目 id 形如 mcp:rea/<tool>
        enabled: true
        title: REA reverse engineering
        description: 索引中显示的一两句话；默认取服务器 instructions
        transport: stdio          # 或 streamable-http（配 url、headers）
        command: rea
        args: [mcp]
        env: {}                   # 叠加在已清洗凭据的父进程环境之上
        allowTools: []            # 通配符白名单，空表示全部
        denyTools: []             # 通配符黑名单，优先于白名单
        families:                 # 人工能力族；未匹配的按名称自动分组，服务器在 _meta 中声明的 family 也会被采用
          - name: javascript
            description: JS/Electron 应用
            match: ['*javascript*', '*electron*']
        idleDisconnectMs: 300000  # 空闲断开
        callTimeoutMs: 600000
        discoveryTimeoutMs: 60000
        catalogTtlMs: 86400000    # 缓存超过此时长后后台刷新
    skills:
      enabled: true
      takeOverCatalog: true       # 用索引替换原生 skill 目录
      indexMode: brief            # brief：名称 + 短描述；names：只列名称
      briefChars: 80
      families: []
      allow: []
      deny: []
    toolNames: { search: capability_search, describe: capability_describe, call: capability_call }
    limits: { searchLimit: 8, maxSearchLimit: 60, schemaInlineMaxBytes: 6000, describeMaxChars: 14000, callResultMaxChars: 120000 }
    cacheDir: ''                  # 默认 $DSH_HOME/capability-catalog
```

覆盖这一行时会替换整个 `config`，请写全自己要保留的字段。

其他包添加服务器而不覆盖主配置：

```yaml
- insert:
    - id: capability-catalog-github
      name: '@kirkchinese/dsh-capability-catalog/server'
      config: { name: github, command: npx, args: ['-y', '@modelcontextprotocol/server-github'] }
```

## 开关与设置界面

- 全局：「插件」页本插件（或整合包）详情中的设置卡片。
- 会话：输入框左侧「能力」按钮，每项「默认 / 开 / 关」。
- 生效顺序：会话 > 全局 > 配置（`mcp[].enabled`，skill 默认开启）。全局关闭的服务器不运行；会话关闭只对该会话隐藏。
- 状态文件：`cacheDir/toggles.json`，最多保留最近 500 个会话的覆盖。

## 行为细节

- **缓存：** 工具清单写入 `cacheDir/mcp-<name>.json`，键为命令、参数、环境、URL 的哈希。有缓存时启动不连接服务器；启动时的首次发现结束后立即断开。
- **连接：** 检索与说明只读缓存，只有 `capability_call` 会连接服务器；空闲 `idleDisconnectMs` 后断开；插件卸载或关闭时立即断开。
- **skill 接管：** 为每个 agent 注册同名的作用域 `skill` 工具，原生目录因此停止发送；`/name` 手势由原生插件继续处理。
- **安全：** 子进程环境沿用 DSH 的凭据清洗；本插件不提升任何权限。`capability_call` 是普通工具，照常经过 DSH 的审批流程，但审批粒度是这一个工具名，而不是每个 MCP 工具。

## 已知限制

- 中文查询与英文工具描述之间没有语义匹配；索引用英文族名，模型通常用英文检索。
- 多一步检索与说明；对每轮都要用到的少数工具，直接注册更简单。
- MCP 结果中的图片、音频以文字占位，不进入模型上下文。
- 原生延迟加载（`defer_loading` + `tool_reference`）需要 DSH DeepSeek 适配器支持，见仓库 `docs/upstream/`。
