# 站点观测接收器

Node.js 本地数据接入项目。来源服务与业务存储相互独立；采集结果写入本地持久集合，业务读取入口基于同一状态生成日报。每次采集保留同一站点小时的各个质控版本，重复批次不会重复计数；日报覆盖范围来自应报站点清单，缺测和未返回的站点仍会出现在日报中。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为、日报规则与本地接口测试；`npm run demo` 启动临时来源，依次采集 opening、updated 两个来源观察并打印日报，结束时关闭监听并清理临时数据。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。`npm run report -- [站点清单] [日期] [来源地址]` 生成日报；给出来源地址（或设置 `SOURCE_URL`）时先采集再生成，可用 `COLLECTION_STATE` 指定状态文件。演示数据不访问生产站点。

## 观测语义

- **观测值**：`value` 是数值；`quality` 为 `provisional`、`validated` 或 `missing`；`reason` 说明缺测原因（如 `maintenance`）；`revision` 是质控更正版本。`null` 与 `0` 不等价，`missing` 行的 `value` 恒为 `null`，即使来源送来了占位的 `0`，原值仅保留在 `attributes.reportedValue`。
- **版本**：同一 `sourceId` 的每个 `revision` 都单独保存，`records` 是最新版本视图，`versions` 保留全部历史。同一 `sourceId + revision` 的内容不一致时记为冲突，不静默选取其中一个。
- **重复批次**：相同的 `sourceId + revision` 再次到达只计入 `duplicates`，不会新增站点、版本或日报覆盖率。
- **引用**：每行带 `basis`（如 `S1-08@2`）与 `citation`。质控更正到达后，当前日报和引用依据一起更新；旧版本仍在 `versions` 中可追溯。

## 日报规则

日报由 `fixtures/population.json` 形式的应报清单（stations × hours）驱动，而不是本次返回了哪些记录。每个应报站点小时都会出现，状态为 `validated`、`provisional`、`missing`（明确缺测）、`absent`（未返回）、`conflict` 或 `invalid`。只有全部应报单元都是有效 `validated` 观测时，对应汇总才为 `determined`；否则值为 `null`，并在 `undeterminedSummaries` 中列出不能判定的汇总及原因（含缺测站点与原因）。按站点、按小时的汇总遵循同一规则。`missingStations` 与 `notReceivedStations` 区分"明确缺测"和"完全没收到"。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析每一页并通过 `next` 读取完整批次；`src/records.js` 负责校验、版本合并与状态判定；`src/service.js` 与 `src/repository.js` 维护持久状态；`src/report.js` 生成日报；`src/operations.js` 是业务消费入口（`rows`、`versions`、`dailyReport`）；`src/report-cli.js` 是日报命令。来源协议见 [CONTRACT.md](CONTRACT.md)。

状态目录属于运行产物。`npm run acceptance` 在临时目录中验证来源读取、首批导入、重启回读、重放、质控更正与日报覆盖，完成后清理临时状态。
