import { createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Everything the OAuth server issues (client IDs, authorization codes, access and refresh tokens) is a
// self-contained HMAC-signed blob, so the server needs no database and survives restarts and
// scale-to-zero. All keys derive from MCP_ACCESS_KEY: rotating that secret invalidates everything.

export type TokenKind = 'client' | 'client-secret' | 'request' | 'code' | 'access' | 'refresh';

const KINDS: TokenKind[] = ['client', 'client-secret', 'request', 'code', 'access', 'refresh'];

export class TokenSigner {
  private readonly keys: Map<TokenKind, Buffer>;
  private readonly secretDigest: Buffer;

  constructor(secret: string) {
    // scrypt makes offline guessing of the secret from a signed token expensive, even for weak secrets.
    const master = scryptSync(secret, 'gemini-mcp/oauth/v1', 32, { N: 2 ** 14, r: 8, p: 1 });
    this.keys = new Map(
      KINDS.map((kind) => [kind, Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `gemini-mcp:${kind}`, 32))]),
    );
    this.secretDigest = sha256(secret);
  }

  /** Constant-time comparison against the configured secret. */
  matchesSecret(candidate: string): boolean {
    return timingSafeEqual(sha256(candidate), this.secretDigest);
  }

  sign(kind: TokenKind, payload: object, macBytes = 32): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(kind, body, macBytes)}`;
  }

  verify<T>(kind: TokenKind, token: string, macBytes = 32): T | undefined {
    const dot = token.lastIndexOf('.');
    if (dot <= 0 || token.length > 8_192) return undefined;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = Buffer.from(this.mac(kind, body, macBytes), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    } catch {
      return undefined;
    }
  }

  mac(kind: TokenKind, data: string, bytes = 32): string {
    const key = this.keys.get(kind)!;
    return createHmac('sha256', key).update(data).digest().subarray(0, bytes).toString('base64url');
  }
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
