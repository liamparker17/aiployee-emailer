import type { McpServerConn } from '../repos/mcpServers.js';

export interface AgentTool { name: string; description: string; parameters: Record<string, unknown> }

/** Aggregates tools across a tenant's MCP servers and routes calls. Injectable for tests. */
export interface McpToolProvider {
  listTools(): Promise<AgentTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export type McpProviderFactory = (servers: McpServerConn[]) => McpToolProvider;

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

/**
 * Default provider over the official MCP SDK (Streamable HTTP). Tool names are
 * prefixed with the server name (`<server>__<tool>`) to avoid collisions across
 * servers; calls are routed back to the owning server by that prefix. Connections
 * are opened lazily on first listTools and reused until close().
 */
export const defaultMcpProviderFactory: McpProviderFactory = (servers) => {
  type Client = import('@modelcontextprotocol/sdk/client/index.js').Client;
  const clients = new Map<string, Client>();          // serverId -> connected client
  const routes = new Map<string, { serverId: string; original: string }>(); // prefixedName -> origin

  async function connect(server: McpServerConn): Promise<Client> {
    const existing = clients.get(server.id);
    if (existing) return existing;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'aiployee-agent', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.auth ? { headers: { Authorization: server.auth } } : undefined,
    });
    await client.connect(transport);
    clients.set(server.id, client);
    return client;
  }

  return {
    async listTools() {
      const out: AgentTool[] = [];
      for (const server of servers) {
        try {
          const client = await connect(server);
          const res = await client.listTools();
          for (const t of res.tools) {
            const name = `${sanitize(server.name)}__${t.name}`;
            routes.set(name, { serverId: server.id, original: t.name });
            out.push({ name, description: t.description ?? '', parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} } });
          }
        } catch {
          // A bad/unreachable MCP server must not break the whole agent run.
        }
      }
      return out;
    },
    async callTool(name, args) {
      const route = routes.get(name);
      if (!route) return `Error: unknown tool ${name}`;
      const server = servers.find(s => s.id === route.serverId);
      if (!server) return `Error: tool ${name} has no server`;
      try {
        const client = await connect(server);
        const res = await client.callTool({ name: route.original, arguments: args }) as { content?: Array<{ type: string; text?: string }> };
        const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
        return text || JSON.stringify(res);
      } catch (e) {
        return `Error calling ${name}: ${(e as Error).message}`;
      }
    },
    async close() {
      for (const client of clients.values()) {
        try { await client.close(); } catch { /* ignore */ }
      }
      clients.clear();
    },
  };
};
