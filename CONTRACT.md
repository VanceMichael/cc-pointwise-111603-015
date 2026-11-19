# 来源与消费契约

## 来源

入口 `/stations/S1/hourly`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening、updated 与 paged 是若干可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

observationId 对应站点小时，revision 是质控更正版本；quality 为 provisional/validated/missing。provisional 可展示暂定值但不进入最终汇总，validated 才是最终有效观测。null 与数值 0 不等价，未返回和明确缺测也不同。fixtures/population.json 定义日报期望站点集合，不能从本次返回列表反推总体。有效覆盖按期望站点与小时判断。

## 采集生命周期

采集按 `next` 读取完整批次，按 `sourceId + revision` 保存：每个版本只保存一次，重复批次计为重复而不新增站点或版本；同一 revision 内容不同则记录冲突。`sourceId` 的最新 revision 是当前视图，旧版本保留用于审计。缺测行的观测值恒为 null，原因保留在 `reason`；不得把缺测改写为有效零值。

## 业务消费

`readOperations(repository, {population, date})` 返回 `rows`（当前视图）、`versions`（全部版本，带 revision 与 citation）和 `conflicts`；传入 population 时返回 `dailyReport`。日报按 population 的站点与小时全量展开，缺测/未返回的站点仍出现并标出状态与原因；只有覆盖完整且全部为 validated 的汇总才是 `determined`，否则汇总值为 null 并在 `undeterminedSummaries` 说明哪些汇总不能判定。质控更正到达后，日报与其引用依据（`basis`/`citation`）一致更新，历史版本仍可追溯。

原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
