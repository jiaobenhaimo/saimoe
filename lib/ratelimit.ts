// 进程内滑动窗口限流(单实例适用;CloudBase 云托管按 Dockerfile 部署就是单实例)。
// 超限返回 true。防止刷票/批量提名拖垮 Bangumi 接口。

const buckets = new Map<string, number[]>();

function prune(now: number): void {
  // 丢弃已过期的键。此前是 buckets.clear(),会把所有人的配额一并清零,
  // 等于给刷票者一个「重置窗口」;改为只清理真正过期的条目。
  for (const [k, arr] of buckets) {
    const live = arr.filter((t) => now - t < 600_000); // 最长窗口的宽松上界
    if (live.length === 0) buckets.delete(k); else buckets.set(k, live);
  }
  if (buckets.size > 50_000) buckets.clear(); // 兜底:异常膨胀才整体清空
}

export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  if (buckets.size > 10_000) prune(Date.now());
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}
