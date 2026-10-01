import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { sendConsentPage } from './consentPage.js';
import { redirectHost, type RedirectPolicy } from './redirects.js';
import { nowSeconds, randomId, sha256, type TokenSigner } from './signer.js';

const PREFIX = { client: 'gmc_', request: 'gmq_', code: 'gmac_', access: 'gmat_', refresh: 'gmrt_' } as const;
const CLIENT_MAC_BYTES = 16;
const AUTH_REQUEST_TTL = 15 * 60;
const AUTH_CODE_TTL = 5 * 60;
const SUPPORTED_AUTH_METHODS = new Set(['none', 'client_secret_post', 'client_secret_basic']);

export interface OAuthSettings {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  redirectPolicy: RedirectPolicy;
  /** Whether a requested `resource` (RFC 8707) refers to this server, judged from the incoming request. */
  isOwnResource: (resource: URL, req: Request) => boolean;
}

interface ClientPayload {
  v: 1;
  r: string[]; // redirect_uris
  a: string; // token_endpoint_auth_method
  n?: string; // client_name
  t: number; // issued at
}

export interface AuthRequestPayload {
  c: string; // client_id
  ru: string; // redirect_uri
  cc: string; // PKCE code_challenge (S256)
  st?: string; // state
  sc: string[]; // scopes
  rs?: string; // resource
  e: number; // expiry
}

interface CodePayload {
  c: string; // client_id hash
  ru: string;
  cc: string;
  sc: string[];
  rs?: string;
  e: number;
  j: string; // unique id for single-use enforcement
}

interface TokenPayload {
  c: string; // client_id hash
  sc: string[];
  rs?: string;
  i: number;
  e: number;
  j?: string;
}

/**
 * OAuth 2.1 authorization server for a single owner: Dynamic Client Registration, PKCE (S256) and
 * refresh-token rotation, with a consent page that asks for the server's access key. Stateless: every
 * artifact is signed, so nothing needs to be stored (single use of authorization codes is enforced
 * per instance, backed by PKCE and a 5-minute lifetime).
 */
export class StatelessOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly usedCodes = new Map<string, number>();

  constructor(
    private readonly signer: TokenSigner,
    private readonly settings: OAuthSettings,
  ) {
    this.clientsStore = {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  // ---- Clients ---------------------------------------------------------------------------

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const redirectUris = client.redirect_uris ?? [];
    if (redirectUris.length === 0) throw new InvalidClientMetadataError('redirect_uris is required');
    if (redirectUris.length > 10) throw new InvalidClientMetadataError('Too many redirect_uris (max 10)');
    for (const uri of redirectUris) {
      if (uri.length > 1_000 || !this.settings.redirectPolicy.isAllowed(uri)) {
        throw new InvalidClientMetadataError(
          `redirect_uri not allowed by this server: ${uri.slice(0, 200)}. Allowed: Claude's callback and loopback URLs ` +
            '(add others with OAUTH_EXTRA_REDIRECT_URIS).',
        );
      }
    }
    const method = client.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!SUPPORTED_AUTH_METHODS.has(method)) {
      throw new InvalidClientMetadataError(`Unsupported token_endpoint_auth_method: ${method}`);
    }
    if (client.grant_types && !client.grant_types.includes('authorization_code')) {
      throw new InvalidClientMetadataError('grant_types must include authorization_code');
    }

    const issuedAt = nowSeconds();
    const payload: ClientPayload = { v: 1, r: redirectUris, a: method, t: issuedAt };
    const name = client.client_name?.trim().slice(0, 80);
    if (name) payload.n = name;
    const clientId = PREFIX.client + this.signer.sign('client', payload, CLIENT_MAC_BYTES);

    const { client_secret: _ignored, client_secret_expires_at: _alsoIgnored, ...metadata } = client;
    return {
      ...metadata,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...this.secretFields(clientId, method),
    };
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (!clientId.startsWith(PREFIX.client)) return undefined;
    const p = this.signer.verify<ClientPayload>('client', clientId.slice(PREFIX.client.length), CLIENT_MAC_BYTES);
    if (!p || p.v !== 1 || !Array.isArray(p.r)) return undefined;
    return {
      client_id: clientId,
      client_id_issued_at: p.t,
      client_name: p.n,
      redirect_uris: p.r,
      token_endpoint_auth_method: p.a,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...this.secretFields(clientId, p.a),
    };
  }

  private secretFields(clientId: string, method: string): { client_secret?: string; client_secret_expires_at?: number } {
    if (method === 'none') return {};
    return { client_secret: this.signer.mac('client-secret', clientId), client_secret_expires_at: 0 };
  }

  // ---- Authorization ---------------------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !this.settings.isOwnResource(params.resource, res.req)) {
      throw new InvalidTargetError(`This server cannot issue tokens for ${params.resource.href}`);
    }
    const request: AuthRequestPayload = {
      c: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      sc: params.scopes ?? [],
      e: nowSeconds() + AUTH_REQUEST_TTL,
    };
    if (params.state !== undefined) request.st = params.state;
    if (params.resource) request.rs = params.resource.href;

    sendConsentPage(res, {
      clientName: client.client_name || 'An MCP client',
      redirectHost: redirectHost(params.redirectUri),
      redirectOrigin: new URL(params.redirectUri).origin,
      request: this.signAuthRequest(request),
    });
  }

  signAuthRequest(request: AuthRequestPayload): string {
    return PREFIX.request + this.signer.sign('request', request);
  }

  /** Validates the signed request carried by the consent form. */
  readAuthRequest(value: string): AuthRequestPayload | undefined {
    if (!value.startsWith(PREFIX.request)) return undefined;
    const p = this.signer.verify<AuthRequestPayload>('request', value.slice(PREFIX.request.length));
    if (!p || p.e < nowSeconds()) return undefined;
    const client = this.getClient(p.c);
    if (!client || !client.redirect_uris.some((registered) => redirectUriMatches(p.ru, registered))) return undefined;
    return p;
  }

  /** Called by the consent handler after the user typed the correct access key. */
  issueAuthorizationCode(request: AuthRequestPayload): string {
    const code: CodePayload = {
      c: clientHash(request.c),
      ru: request.ru,
      cc: request.cc,
      sc: request.sc,
      e: nowSeconds() + AUTH_CODE_TTL,
      j: randomId(),
    };
    if (request.rs) code.rs = request.rs;
    return PREFIX.code + this.signer.sign('code', code);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.readCode(client, authorizationCode).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.readCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== code.ru) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource && code.rs && !sameResource(resource.href, code.rs)) {
      throw new InvalidTargetError('resource does not match the authorization request');
    }
    this.markCodeUsed(code);
    return this.issueTokens(client.client_id, code.sc, code.rs ?? resource?.href);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const p = refreshToken.startsWith(PREFIX.refresh)
      ? this.signer.verify<TokenPayload>('refresh', refreshToken.slice(PREFIX.refresh.length))
      : undefined;
    if (!p || p.e < nowSeconds() || p.c !== clientHash(client.client_id)) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (resource && p.rs && !sameResource(resource.href, p.rs)) {
      throw new InvalidTargetError('resource does not match the original grant');
    }
    let granted = p.sc;
    if (scopes && scopes.length > 0) {
      const extra = scopes.filter((s) => !p.sc.includes(s));
      if (extra.length > 0) throw new InvalidScopeError(`Scopes not originally granted: ${extra.join(' ')}`);
      granted = scopes;
    }
    // Rotation: every refresh returns a fresh refresh token with a renewed lifetime.
    return this.issueTokens(client.client_id, granted, p.rs);
  }

  // ---- Tokens ----------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!token.startsWith(PREFIX.access)) throw new InvalidTokenError('Invalid access token');
    const p = this.signer.verify<TokenPayload>('access', token.slice(PREFIX.access.length));
    if (!p) throw new InvalidTokenError('Invalid access token');
    if (p.e < nowSeconds()) throw new InvalidTokenError('Access token expired');
    return {
      token,
      clientId: p.c,
      scopes: p.sc,
      expiresAt: p.e,
      ...(p.rs ? { resource: new URL(p.rs) } : {}),
    };
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const now = nowSeconds();
    const base = { c: clientHash(clientId), sc: scopes, i: now, ...(resource ? { rs: resource } : {}) };
    const access: TokenPayload = { ...base, e: now + this.settings.accessTokenTtlSeconds };
    const refresh: TokenPayload = { ...base, e: now + this.settings.refreshTokenTtlSeconds, j: randomId(9) };
    return {
      access_token: PREFIX.access + this.signer.sign('access', access),
      token_type: 'Bearer',
      expires_in: this.settings.accessTokenTtlSeconds,
      refresh_token: PREFIX.refresh + this.signer.sign('refresh', refresh),
      ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
    };
  }

  private readCode(client: OAuthClientInformationFull, value: string): CodePayload {
    const p = value.startsWith(PREFIX.code)
      ? this.signer.verify<CodePayload>('code', value.slice(PREFIX.code.length))
      : undefined;
    if (!p || p.c !== clientHash(client.client_id)) throw new InvalidGrantError('Invalid authorization code');
    if (p.e < nowSeconds()) throw new InvalidGrantError('Authorization code expired');
    if (this.usedCodes.has(p.j)) throw new InvalidGrantError('Authorization code already used');
    return p;
  }

  private markCodeUsed(code: CodePayload): void {
    const now = nowSeconds();
    for (const [id, exp] of this.usedCodes) if (exp < now) this.usedCodes.delete(id);
    this.usedCodes.set(code.j, code.e);
  }
}

/** Accepts only static access-key bearer tokens (AUTH_MODE=bearer, or alongside OAuth). */
export function accessKeyAuthInfo(token: string, signer: TokenSigner): AuthInfo | undefined {
  if (!signer.matchesSecret(token)) return undefined;
  return { token, clientId: 'access-key', scopes: [], expiresAt: nowSeconds() + 3600 };
}

function clientHash(clientId: string): string {
  return sha256(clientId).subarray(0, 12).toString('base64url');
}

function sameResource(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

