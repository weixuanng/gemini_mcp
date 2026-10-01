#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type AppConfig, type TransportKind } from './config.js';
import { buildDeps } from './deps.js';
import { createHttpApp } from './http/app.js';
import { createMcpServer } from './server.js';
import { errorMessage, log } from './util/log.js';
import { SERVER_VERSION } from './version.js';

function transportFromArgs(): TransportKind {
  return process.argv.includes('--stdio') || process.env.MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http';
}

async function main(): Promise<void> {
  const transport = transportFromArgs();
  let cfg: AppConfig;
  try {
    cfg = loadConfig(process.env, transport);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const deps = buildDeps(cfg);
  const summary = {
    version: SERVER_VERSION,
    transport,
    tier: cfg.gemini.tier,
    model: cfg.gemini.model,
    deepModel: cfg.gemini.deepModel,
    freeSearchModel: cfg.gemini.freeSearchModel,
    deepResearch: cfg.gemini.deepResearch.enabled,
    auth: transport === 'http' ? cfg.auth.mode : 'n/a',
  };

  if (transport === 'stdio') {
    const server = createMcpServer(deps);
    await server.connect(new StdioServerTransport());
    log.info('Gemini MCP server ready on stdio', summary);
    return;
  }

  if (cfg.auth.mode === 'none') {
    log.warn('AUTH_MODE=none: anyone who can reach this server can use your Gemini API key. Use only for local testing.');
  }
  const app = createHttpApp(cfg, deps);
  const httpServer = app.listen(cfg.http.port, cfg.http.host, () => {
    log.info(`Gemini MCP server listening on http://${cfg.http.host}:${cfg.http.port}`, summary);
  });
  httpServer.on('error', (err) => {
    log.error('HTTP server error', { error: errorMessage(err) });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('Fatal error', { error: errorMessage(err) });
  process.exit(1);
});
