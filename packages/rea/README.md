# @kirkchinese/dsh-rea

通过[能力目录](../capability-catalog)在 DeepSeek Harness 中按需使用 [REA](https://github.com/morluto/rea)：人工整理的 14 个能力族覆盖 REA 6.7.0 的全部 207 个工具，REA 只在模型真正调用时启动。

> **过渡方案。** 以下任一上游改进落地后，本包将弃用：REA 在 `tools/list` 中声明工具族（能力目录会直接采用），或 DSH 的 DeepSeek 适配器支持延迟工具与 `tool_reference`。提案草稿见仓库 `docs/upstream/`。

## 安装

需要先安装能力目录，并让 `rea` 在 PATH 上：

```sh
npm install -g rea-agents
dsh plugin --profile web add @kirkchinese/dsh-capability-catalog
dsh plugin --profile web add @kirkchinese/dsh-rea
```

想一次装好用整合包 [`@kirkchinese/dsh-re-kit`](../re-kit)，两者二选一。

本包插入一行 `capability-catalog-rea`，不改动能力目录主行的配置。要改命令（例如改用 `npx -y rea-agents@6.7.0 mcp`）或关掉 REA，在 profile 的 `cordis.patch.yml` 中覆盖这一行：

```yaml
- id: capability-catalog-rea
  config:
    name: rea
    enabled: false
```

覆盖会替换整个 `config`，`families` 需要的话请一并写上。

## 能力族

| 族 | 内容 | 工具数 |
| --- | --- | --- |
| session | 打开/关闭目标、提供方绑定、导航上下文 | 8 |
| native-code | 函数、伪代码、汇编、调用图与引用 | 28 |
| native-navigation | 地址、字节、字符串、名称、段、注释与书签 | 22 |
| native-formats | Mach-O/PE/ELF、签名、Go/Rust/Swift/ObjC 元数据、objdump、rizin | 20 |
| javascript-electron | JS/Electron 应用、bundle、source map、IPC 与运行时 | 17 |
| web-browser | 浏览器页面、网络抓包、截图、WebMCP | 14 |
| android | APK、类、方法、资源（JADX、Apktool、JEB） | 12 |
| adb-device | adb 设备：包、文件、日志、屏幕与应用控制 | 24 |
| managed-dotnet | .NET 程序集与重建 | 7 |
| apple-bundles | plist、keyed archive、asset catalog、Interface Builder | 6 |
| artifacts | 归档、包、固件、SQLite、分析视图 | 7 |
| runtime-debug | Frida、GDB、rizin 调试、进程与原生 UI 捕获、崩溃记录 | 26 |
| captures-signals | pcap 与逻辑信号 | 6 |
| evidence | Evidence 包、残留未知项与重建验证 | 10 |

规则在 [`families.yml`](families.yml)；`cordis.patch.yml` 由仓库的 `scripts/sync-patches.mjs` 生成。

REA 自带的工作流 skill（`rea setup --skill --yes` 安装到 `~/.agents/skills`）照常可用，其中的工具名对应能力目录 id `mcp:rea/<name>`。
