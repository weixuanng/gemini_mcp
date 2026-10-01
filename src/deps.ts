import type { AppConfig } from './config.js';
import { GeminiClient } from './gemini/client.js';
import { GeminiRunner } from './gemini/runner.js';
import type { ToolDeps } from './tools/common.js';
import { DailyLimiter } from './util/limits.js';

export function buildDeps(cfg: AppConfig, fetchImpl?: typeof fetch): ToolDeps {
  const client = new GeminiClient({
    apiKey: cfg.gemini.apiKey,
    baseUrl: cfg.gemini.baseUrl,
    apiVersion: cfg.gemini.apiVersion,
    fetchImpl,
  });
  return { cfg, runner: new GeminiRunner(client, cfg.gemini), limiter: new DailyLimiter(cfg.dailyCallLimit) };
}
