# dsh-capability-catalog

**让 DeepSeek Harness 知道有哪些工具和 skill，而不把它们的全部定义塞进每一次请求。**

DSH 会把每个可见工具的完整 schema 放进每次请求。接一个 REA 这样的 MCP 服务器（207 个工具、约 668 KB 参数定义），每个会话的第一个请求就要多带约 25 万输入 token。skill 目录也是同类问题，只是小一些。

本插件把 MCP 工具和 skill 放进一个统一的能力目录：

- 系统提示词里只放一份紧凑的分组索引，模型知道有哪些能力族、每族有哪些代表；
- 三个固定工具按需取用：`capability_search` 检索或浏览某族，`capability_describe` 查看准确参数（超大 schema 先给紧凑签名，可按 JSON Pointer 展开），`capability_call` 校验参数后调用；
- 模型看到的工具列表在会话中从不变化，前缀缓存稳定，也不依赖 DSH 目前在 DeepSeek 官方端点上有问题的会话中途追加工具机制；
- MCP 服务器用到才启动，空闲自动断开；工具清单缓存在磁盘上，启动 DSH 时不必拉起服务器；每个服务器和整个插件都有开关；
- 接管 skill 目录：原生目录不再逐会话发送全部描述，改由索引列出名称和短描述，`skill` 工具与 `/name` 用法不变；
- 每个 MCP 服务器、每个 skill 都能单独开关，分全局和会话两级：「插件」页的设置卡片管全局，输入框左侧的「能力」按钮管当前会话（默认 / 开 / 关）。

## 实测（DeepSeek 官方 API，DSH 0.2.1-rc.2 隔离实例）

| 场景 | 直接注册 REA | 通过能力目录 |
| --- | --- | --- |
| 首个请求输入 token | 249,653 | 约 9,200（含 REA 索引、59 个 skill 的索引和全部内置工具） |
| REA 在提示词中的常驻内容 | 约 668 KB schema | 约 2.3 KB 分组索引 |
| 最大单个 schema（`compare_web_captures`） | 166 KB | 紧凑签名约 2.3 KB，按需展开 |
| 59 个 skill 的目录 | 原生目录，每条描述最多 500 字符 | 约 5.1 KB（名称 + 短描述） |

0.2.1-rc.3 上同样实测通过。

## 包

| 包 | 用途 |
| --- | --- |
| [`@kirkchinese/dsh-capability-catalog`](packages/capability-catalog) | 通用能力目录插件 |
| [`@kirkchinese/dsh-rea`](packages/rea) | REA 适配：人工整理的 14 个能力族。上游支持后弃用 |
| [`@kirkchinese/dsh-re-kit`](packages/re-kit) | 整合包：能力目录 + REA，一次安装 |

## 安装

兼容 DSH `0.2.1-rc.2`（npm `latest`）与 `0.2.1-rc.3`，Node.js `^22.19.0 || >=24.0.0`。

整合包（需要先全局安装 `rea-agents`，使 `rea` 在 PATH 上）：

```sh
npm install -g rea-agents
dsh plugin --profile web add @kirkchinese/dsh-re-kit
```

只装能力目录，再在 profile 的 `cordis.patch.yml` 里配置自己的 MCP 服务器：

```sh
dsh plugin --profile web add @kirkchinese/dsh-capability-catalog
```

```yaml
- id: capability-catalog
  config:
    mcp:
      - name: github
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
```

其他包也可以各自插入一行 `@kirkchinese/dsh-capability-catalog/server` 来添加服务器，互不覆盖配置。整合包与单独的包二选一，不要同时安装。

## 设置界面

- **插件页 → 能力目录（或逆向工具整合包）**：常驻索引大小、MCP 服务器的运行状态与开关、按族分组的 skill 开关（搜索、按开/关筛选、每族一键全开/全关）。全局生效，立即生效；关掉的服务器会停止运行。
- **输入框左侧「能力」按钮**：只作用于当前会话，每项可选「默认 / 开 / 关」，按钮上显示本会话关闭了几项；「恢复默认」清除本会话的全部覆盖。

生效顺序：会话设置 > 全局设置 > 配置文件默认值。关掉的能力从索引、检索和调用中一并移除；模型直接调用时会得到“已在本会话关闭”的提示。开关保存在 `$DSH_HOME/capability-catalog/toggles.json`，不写入会话日志。

关闭整个插件：把 `capability-catalog` 行的 `enabled` 设为 `false`，此时不注册工具、不进索引、不运行任何 MCP 服务器，原生 skill 目录恢复。完整配置项见[插件说明](packages/capability-catalog/README.md)。

## 设计与上游

- [设计文档](docs/design.zh.md)
- 已向上游提出的改进草稿：[DSH：工具结果支持 `tool_reference`](docs/upstream/dsh-discussion-tool-reference.md)、[REA：在 tools/list 中声明工具族](docs/upstream/rea-issue-family-metadata.md)。实测表明 DeepSeek 端点已经支持“延迟工具 + `tool_reference`”，DSH 适配器支持之后，本插件会增加原生延迟加载模式。

## 开发

```sh
pnpm install
pnpm test                          # 编译并运行单元测试
node scripts/sync-patches.mjs      # 由 packages/rea/families.yml 生成各包的 patch
node scripts/pack-local.mjs /tmp/packs   # 打包本地测试用 tarball
```

## 许可证

[MIT](LICENSE)
