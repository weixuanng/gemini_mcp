import { isLoopbackHost } from '../../config.js';

/** Claude's hosted OAuth callback (claude.ai, Desktop, mobile, Cowork). claude.com is accepted for forward compatibility. */
export const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

export interface RedirectPolicyOptions {
  extraRedirectUris: string[];
  allowAnyRedirectUri: boolean;
}

/**
 * Which redirect URIs a client may register. Defaults to Claude's callback plus loopback URLs
 * (Claude Code, MCP Inspector, other local clients), which keeps a phished consent from sending a
 * code to an arbitrary website.
 */
export class RedirectPolicy {
  private readonly exact: Set<string>;

  constructor(private readonly opts: RedirectPolicyOptions) {
    this.exact = new Set([...CLAUDE_CALLBACKS, ...opts.extraRedirectUris]);
  }

  isAllowed(uri: string): boolean {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.hash) return false;
    const loopback = u.protocol === 'http:' && isLoopbackHost(u.hostname);
    if (u.protocol !== 'https:' && !loopback) return false;
    if (this.opts.allowAnyRedirectUri) return true;
    if (loopback) return true;
    return this.exact.has(uri);
  }
}

/** Host shown on the consent screen so the user can see where approval sends them. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}
