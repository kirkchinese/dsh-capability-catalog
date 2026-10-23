# @kirkchinese/dsh-re-kit

一次安装 [能力目录](../capability-catalog) 和 [REA 适配](../rea)：

```sh
npm install -g rea-agents
dsh plugin --profile web add @kirkchinese/dsh-re-kit
```

整合包自带两行配置：`capability-catalog`（默认配置，接管 skill 目录）和 `capability-catalog-rea`。不要再单独安装 `@kirkchinese/dsh-capability-catalog` 或 `@kirkchinese/dsh-rea`，否则同名行会冲突。

在 profile 的 `cordis.patch.yml` 中覆盖这两行即可调整，例如关闭 skill 接管：

```yaml
- id: capability-catalog
  config:
    skills: { takeOverCatalog: false }
```
