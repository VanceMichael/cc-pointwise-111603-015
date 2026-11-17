# 站点观测接收器

Node.js 本地数据接入项目。已有一次来源读取、结构化导入与操作查询，来源服务和业务存储独立，来源变化不会自动刷新本地集合。小时观测按版本接入：观测值、缺测原因与质控更正在接入边界显式分开，同一站点小时的全部 revision 版本保留，重复批次重放不会多算站点；日报覆盖范围来自应报站点清单，缺测与未收到的站点照常出现且不进入汇总。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源，依次演示初报、缺测到达与质控修正三个阶段的日报，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入通用记录，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析现有首批页面并保留原始来源属性，返回 records 和 next；目前 demo 只导入首批。`src/service.js` 与 `src/repository.js` 维护持久集合；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

小时观测的版本化接入在 `src/observations.js`：`missing` 必须 `value: null` 且带原因，`validated`/`provisional` 必须是数值（真实的 0 是有效观测，null 不是 0）。`ObservationService` 把每个 observationId 的全部 revision 追加进版本历史，当前版本取最高 revision；同一 revision 重复到达视为重放，内容冲突或站点小时身份冲突会报错。观测状态独立存放于 `var/observations.json`，与通用记录集合互不影响。

`src/daily-report.js` 生成日报：覆盖单元来自 `fixtures/population.json` 的应报站点 × 小时，与本次返回了哪些记录无关。未收到是 `absent`、明确缺测是 `missing`（带原因），二者都不是零值；`provisional` 展示暂定值但不进汇总；只有覆盖完整且全部 `validated` 的站点才给出日均汇总，汇总引用当前版本（observationId + revision）作为依据，质控修正到达后日报与引用依据一致更新。

状态目录属于运行产物。扩展导入时应保留现有 CLI 和现有集合查询能力；新增状态可以另行组织。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。

`npm start` 或 `npm start -- --help` 查看命令；原导入和查询使用显式的 ingest、query 动作，观测版本导入与日报使用 ingest-observations、report。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放幂等、版本保留、缺测表达与日报汇总判定，完成后清理临时状态。
