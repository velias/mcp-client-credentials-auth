/**
 * Optional tool-name allowlist helpers for MCP_CC_PROXY_ALLOWED_TOOLS.
 * When allowlist is undefined, all tools pass through.
 */

export function createToolAllowlist(
  names: string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!names || names.length === 0) return undefined;
  return new Set(names);
}

export function isToolAllowed(
  allowlist: ReadonlySet<string> | undefined,
  name: string | undefined,
): boolean {
  if (!allowlist) return true;
  if (typeof name !== 'string' || name.length === 0) return false;
  return allowlist.has(name);
}

/**
 * Filter a tools/list JSON-RPC result. Preserves non-tools fields (e.g. nextCursor).
 * Passthrough when allowlist is unset or `tools` is not an array.
 */
export function filterToolsListResult(
  allowlist: ReadonlySet<string> | undefined,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (!allowlist) return result;
  if (!Array.isArray(result.tools)) return result;

  return {
    ...result,
    tools: result.tools.filter(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        typeof (tool as { name?: unknown }).name === 'string' &&
        allowlist.has((tool as { name: string }).name),
    ),
  };
}
