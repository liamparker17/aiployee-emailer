import type pg from 'pg';
import { type LlmFactory, type LlmMessage, openAiFactory, runToolLoop, assembleTenantProviders } from '../runner.js';
import { compositeProvider } from '../mcp.js';
import { getAgentConfig, getAgentOpenAIKey } from '../../repos/agent.js';
import { getGoal } from '../../repos/agentGoals.js';
import { insertChatMessage, listChatMessages } from '../../repos/agentChat.js';
import { getLineReportConfig } from '../../repos/lineReportConfigs.js';
import { buildAbeSystemPrompt } from './prompt.js';
import { makeAbeChatProvider } from './chatTools.js';
import { makeLineChatProvider } from './lineChatTools.js';

export async function runAbeChat(args: {
  pool: pg.Pool; encKey: Buffer; tenantId: string; baseUrl: string; userMessage: string; llmFactory?: LlmFactory;
}): Promise<{ reply: string }> {
  const { pool, encKey, tenantId, baseUrl, userMessage } = args;
  await insertChatMessage(pool, tenantId, 'user', userMessage);

  const apiKey = await getAgentOpenAIKey(pool, encKey, tenantId);
  if (!apiKey) {
    const reply = "I can't think yet — I need an OpenAI key. Open Manage Abe and connect one, then I'll be able to chat.";
    await insertChatMessage(pool, tenantId, 'abe', reply);
    return { reply };
  }
  const llmFactory = args.llmFactory ?? openAiFactory;
  const llm = llmFactory(apiKey);
  const cfg = await getAgentConfig(pool, tenantId);
  const model = cfg?.model ?? 'gpt-4.1';
  const goal = await getGoal(pool, tenantId);
  const lineCfg = await getLineReportConfig(pool, tenantId);

  const history = await listChatMessages(pool, tenantId); // includes the user msg we just inserted
  const messages: LlmMessage[] = [
    { role: 'system', content: buildAbeSystemPrompt(goal?.brand_voice ?? null, lineCfg?.client_name, lineCfg?.client_context) },
    ...history.map(m => ({ role: (m.role === 'abe' ? 'assistant' : 'user') as 'assistant' | 'user', content: m.content })),
  ];

  const provider = compositeProvider([
    makeAbeChatProvider({ pool, encKey, tenantId, baseUrl, llmFactory }),
    makeLineChatProvider({ pool, tenantId, llm: llm as any, model }),
    ...(await assembleTenantProviders(pool, encKey, tenantId, apiKey)),
  ]);
  try {
    const reply = await runToolLoop({
      llm, model, messages, provider,
      maxIter: Math.max(1, cfg?.max_tool_iterations ?? 6),
    }) || "I didn't have anything to add.";
    await insertChatMessage(pool, tenantId, 'abe', reply);
    return { reply };
  } finally {
    await provider.close();
  }
}
