# 来源与消费契约

## 来源

入口 `/stations/S1/hourly`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

observationId 对应站点小时，revision 是质控更正版本；quality 为 provisional/validated/missing。provisional 可展示暂定值但不进入最终汇总，validated 才是最终有效观测。null 与数值 0 不等价，未返回和明确缺测也不同。fixtures/population.json 定义日报期望站点集合，不能从本次返回列表反推总体。有效覆盖按期望站点与小时判断。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
