import type pg from 'pg';
import type { McpToolProvider, AgentTool } from './mcp.js';
import { searchDocuments } from '../repos/ragDocuments.js';

const SEARCH_TOOL: AgentTool = {
  name: 'search_knowledge',
  description: 'Search the tenant knowledge base for relevant context. Use this to ground answers in stored documents.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
};

export function ragVectorProvider(args: {
  pool: pg.Pool;
  tenantId: string;
  embed: (text: string) => Promise<number[]>;
  enabled: boolean;
}): McpToolProvider {
  return {
    async listTools(): Promise<AgentTool[]> {
      if (!args.enabled) return [];
      return [SEARCH_TOOL];
    },

    async callTool(name: string, toolArgs: Record<string, unknown>): Promise<string> {
      if (name !== 'search_knowledge') return 'Error: unknown tool ' + name;
      try {
        const emb = await args.embed(String(toolArgs.query));
        const matches = await searchDocuments(args.pool, args.tenantId, emb, 5);
        if (matches.length === 0) return 'No relevant documents found.';
        const text = matches.map(m => `[${m.source}] ${m.content}`).join('\n\n');
        return text.length > 4000 ? text.slice(0, 4000) : text;
      } catch (e) {
        return 'Error: ' + (e as Error).message;
      }
    },

    async close(): Promise<void> {
      return;
    },
  };
}
