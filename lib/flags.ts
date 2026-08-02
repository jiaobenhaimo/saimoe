/** Bangumi network API (search / character / subject import) is OFF unless
 * BANGUMI_API_ENABLED is exactly "true". Default = disabled. */
export function bangumiApiEnabled(): boolean {
  return process.env.BANGUMI_API_ENABLED === "true";
}
