import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AppConfig } from '../config.js';
import { createMcpServer } from '../server.js';
import type { ToolDeps } from '../tools/common.js';
import { errorMessage, log } from '../util/log.js';
import { sleep } from '../util/sleep.js';
import { sendConsentPage, sendMessagePage } from './oauth/consentPage.js';
import { accessKeyAuthInfo, StatelessOAuthProvider } from './oauth/provider.js';
import { RedirectPolicy, redirectHost } from './oauth/redirects.js';
import { TokenSigner } from './oauth/signer.js';

const MCP_PATH = '/mcp';
const HOST_HEADER = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

export function createHttpApp(cfg: AppConfig, deps: ToolDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.http.trustProxy);

  app.use(requestLogger);

  /** External origin of this server: PUBLIC_URL if set, otherwise derived from the request. */
  const baseUrl = (req: Request): string => {
    if (cfg.http.publicUrl) return cfg.http.publicUrl;
    return `${req.protocol}://${req.get('host')}`;
  };

  app.use((req, res, next) => {
    if (!cfg.http.publicUrl && !HOST_HEADER.test(req.get('host') ?? '')) {
      res.status(400).json({ error: 'invalid_host' });
      return;
    }
    next();
  });

  app.get('/', (req, res) => {
    res
      .type('text/plain')
      .send(
        `Gemini MCP server is running.\n\nAdd it to Claude as a custom connector with this URL:\n${baseUrl(req)}${MCP_PATH}\n`,
      );
  });
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  const signer = cfg.auth.mode === 'none' ? undefined : new TokenSigner(cfg.auth.accessKey!);
  const provider =
    cfg.auth.mode === 'oauth' && signer
      ? new StatelessOAuthProvider(signer, {
          accessTokenTtlSeconds: cfg.auth.accessTokenTtlSeconds,
          refreshTokenTtlSeconds: cfg.auth.refreshTokenTtlSeconds,
          redirectPolicy: new RedirectPolicy(cfg.auth),
          isOwnResource: (resource, req) => resource.origin === new URL(baseUrl(req)).origin,
        })
      : undefined;

  if (provider && signer) {
    // Accept client_secret_basic as well as client_secret_post (the SDK only reads the body).
    app.use('/token', express.urlencoded({ extended: false, limit: '64kb' }), basicClientAuthShim);

    // The SDK's authorization-server router bakes the issuer URL in, so build one per origin (once).
    // Each router owns its rate limiters; building it lazily is fine because it is cached.
    const lazyLimiter = { validate: { creationStack: false } };
    const buildAuthRouter = (base: string): RequestHandler =>
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(base),
        resourceServerUrl: new URL(`${base}${MCP_PATH}`),
        resourceName: 'Gemini MCP',
        authorizationOptions: { rateLimit: lazyLimiter },
        tokenOptions: { rateLimit: lazyLimiter },
        clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0, rateLimit: lazyLimiter },
      });
    const routers = new Map<string, RequestHandler>();
    if (cfg.http.publicUrl) routers.set(cfg.http.publicUrl, buildAuthRouter(cfg.http.publicUrl));

    app.use((req, res, next) => {
      const base = baseUrl(req);
      let router = routers.get(base);
      if (!router) {
        try {
          router = buildAuthRouter(base);
        } catch (err) {
          log.error('Cannot create OAuth endpoints for this origin', { base, error: errorMessage(err) });
          res.status(500).json({
            error: 'server_error',
            error_description: 'OAuth requires https (set PUBLIC_URL, or use localhost for testing).',
          });
          return;
        }
        if (routers.size >= 16) routers.clear();
        routers.set(base, router);
      }
      router(req, res, next);
    });

    const consentLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      skipSuccessfulRequests: true,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        sendMessagePage(res, 429, 'Too many attempts', 'Too many incorrect access keys. Wait 15 minutes, then try again.'),
    });

    app.post(
      '/authorize/consent',
      consentLimiter,
      express.urlencoded({ extended: false, limit: '64kb' }),
      async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const requestToken = typeof body.request === 'string' ? body.request : '';
        const pending = provider.readAuthRequest(requestToken);
        if (!pending) {
          sendMessagePage(
            res,
            400,
            'Sign-in request expired',
            'This sign-in request is invalid or has expired. Go back to Claude and start connecting again.',
          );
          return;
        }
        const client = provider.getClient(pending.c);
        const target = new URL(pending.ru);

        if (body.action === 'deny') {
          target.searchParams.set('error', 'access_denied');
          target.searchParams.set('error_description', 'The user denied access.');
          if (pending.st !== undefined) target.searchParams.set('state', pending.st);
          res.redirect(302, target.href);
          return;
        }

        if (typeof body.access_key !== 'string' || !signer.matchesSecret(body.access_key)) {
          log.warn('OAuth consent: wrong access key', { ip: req.ip });
          await sleep(500);
          sendConsentPage(
            res,
            {
              clientName: client?.client_name || 'An MCP client',
              redirectHost: redirectHost(pending.ru),
              redirectOrigin: target.origin,
              request: requestToken,
              error: 'That access key is not correct.',
            },
            401,
          );
          return;
        }

        target.searchParams.set('code', provider.issueAuthorizationCode(pending));
        if (pending.st !== undefined) target.searchParams.set('state', pending.st);
        log.info('OAuth consent approved', { client: client?.client_name, redirectHost: target.host });
        res.redirect(302, target.href);
      },
    );
  }

  const verifier: OAuthTokenVerifier | undefined = signer && {
    verifyAccessToken: async (token: string) => {
      const keyAuth = accessKeyAuthInfo(token, signer);
      if (keyAuth) return keyAuth;
      if (provider) return provider.verifyAccessToken(token);
      throw new InvalidTokenError('Invalid access key');
    },
  };

  const requireAuth: RequestHandler = (req, res, next) => {
    if (!verifier) {
      next();
      return;
    }
    const resourceMetadataUrl = provider
      ? getOAuthProtectedResourceMetadataUrl(new URL(`${baseUrl(req)}${MCP_PATH}`))
      : undefined;
    requireBearerAuth({ verifier, resourceMetadataUrl })(req, res, next);
  };

  app.post(MCP_PATH, requireAuth, express.json({ limit: '5mb' }), async (req: Request, res: Response) => {
    // Stateless Streamable HTTP: a fresh server and transport per request, so any instance can serve any call.
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('MCP request failed', { error: errorMessage(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' }, id: null });
  };
  app.get(MCP_PATH, requireAuth, methodNotAllowed);
  app.delete(MCP_PATH, requireAuth, methodNotAllowed);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 500) log.error('Unhandled error', { error: errorMessage(err) });
    if (!res.headersSent) res.status(status).json({ error: status >= 500 ? 'server_error' : 'bad_request' });
  });

  return app;
}

const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    // Paths only: query strings can carry OAuth codes.
    log.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
  });
  next();
};

const basicClientAuthShim: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const body = req.body as Record<string, unknown> | undefined;
  if (header?.startsWith('Basic ') && body && typeof body === 'object' && body.client_secret === undefined) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep > 0) {
      try {
        const id = decodeURIComponent(decoded.slice(0, sep));
        const secret = decodeURIComponent(decoded.slice(sep + 1));
        if (body.client_id === undefined || body.client_id === id) {
          body.client_id = id;
          body.client_secret = secret;
        }
      } catch {
        // Malformed encoding: leave the body alone and let client authentication fail normally.
      }
    }
  }
  next();
};
