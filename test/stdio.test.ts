import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { API_KEY, startMockGemini, type MockGemini } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let mock: MockGemini;

before(async () => {
  mock = await startMockGemini();
});
after(async () => {
  await mock?.close();
});

test('stdio transport: local use from Claude Desktop / Claude Code', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts', '--stdio'],
    cwd: root,
    env: { PATH: process.env.PATH ?? '', GEMINI_API_KEY: API_KEY, GEMINI_API_BASE_URL: mock.url, LOG_LEVEL: 'error' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5, 'deep research tools are off by default');
    const result = (await client.callTool({
      name: 'gemini_web_search',
      arguments: { query: 'How tall is the Eiffel Tower?' },
    })) as CallToolResult;
    assert.ok(!result.isError);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    assert.match(text, /## Gemini research/);
  } finally {
    await client.close();
  }
});
