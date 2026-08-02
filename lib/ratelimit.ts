// 进程内滑动窗口限流(单实例适用;CloudBase 云托管按 Dockerfile 部署就是单实例)。
// 超限返回 true。防止刷票/批量提名拖垮 Bangumi 接口。

const buckets = new Map<string, number[]>();

export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  if (buckets.size > 10_000) buckets.clear(); // 防止 key 无限增长
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}
