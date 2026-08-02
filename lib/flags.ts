/** Master switch for THIS service's own API. Every route except /api/health is
 * gated by it. Disabled unless API_ENABLED is exactly "true" (default = off). */
export function apiEnabled(): boolean {
  return process.env.API_ENABLED === "true";
}
