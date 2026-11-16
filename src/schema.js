export const schema = Object.freeze({
  "product": "站点观测接收器",
  "entity": "小时观测",
  "identity": "sourceId",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "空气质量站点的缺测与更正采集"
});
