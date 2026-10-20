// Only split complete numeric values. Never infer a unit, round a value, or
// assign positive/negative meaning to arbitrary business data.
export function metricParts(value) {
  const text = String(value ?? "");
  const match = /^([¥$€£]?[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\s*(?:%|％|‰|bp|元|万元|亿元|件|份|项|笔|人|天|小时|分钟|秒|USD|CNY|KB|MB|GB)?)$/.exec(text);
  return match ? { number: match[1], unit: match[2] } : null;
}
