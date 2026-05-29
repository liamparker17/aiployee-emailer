import pg from 'pg';
import type { RagSqlConn } from '../repos/ragSqlSources.js';
import type { AgentTool, McpToolProvider } from './mcp.js';

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

export function ragSqlProvider(sources: RagSqlConn[]): McpToolProvider {
  // Build the tool-name -> source map once at construction time.
  const toolMap = new Map<string, RagSqlConn>();
  for (const source of sources) {
    const toolName = `sql_${sanitize(source.name)}`;
    toolMap.set(toolName, source);
  }

  return {
    async listTools(): Promise<AgentTool[]> {
      const out: AgentTool[] = [];
      for (const [name, source] of toolMap) {
        out.push({
          name,
          description: `Run a READ-ONLY SQL query against the "${source.name}" database`,
          parameters: {
            type: 'object',
            properties: {
              sql: { type: 'string', description: 'A single read-only SELECT statement' },
            },
            required: ['sql'],
          },
        });
      }
      return out;
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const source = toolMap.get(name);
      if (!source) return `Error: unknown tool ${name}`;

      const pool = new pg.Pool({ connectionString: source.connection });
      const client = await pool.connect().catch((e: Error) => {
        void pool.end();
        return Promise.reject(e);
      });

      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query('SET LOCAL statement_timeout = 5000');
        const r = await client.query(String(args.sql));
        await client.query('ROLLBACK');
        const output = JSON.stringify(r.rows.slice(0, 100));
        return output.length > 4000 ? output.slice(0, 4000) + '…' : output;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        return `Error: ${(e as Error).message}`;
      } finally {
        client.release();
        await pool.end();
      }
    },

    async close(): Promise<void> {
      // No persistent connections are held; each callTool opens and closes its own pool.
      return;
    },
  };
}
