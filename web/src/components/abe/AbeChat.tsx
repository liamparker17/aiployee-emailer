import { useState, useEffect, useRef } from 'react';
import { Send, Bot } from 'lucide-react';
import { Card } from '../Card';
import { Button } from '../Button';
import { Input } from '../Input';
import { useToast } from '../Toast';
import { Skeleton } from '../Skeleton';
import { useAuth } from '../../auth';
import { api } from '../../api';

function describeError(err: unknown): string {
  const e = err as { message?: string; details?: Array<{ path?: (string | number)[]; message?: string }> };
  if (Array.isArray(e?.details) && e.details.length) {
    return e.details.map(i => `${(i.path ?? []).join('.') || 'field'}: ${i.message ?? 'invalid'}`).join('; ');
  }
  return e?.message || 'Something went wrong.';
}

interface ChatMessage {
  id: string;
  role: 'user' | 'abe';
  content: string;
  created_at: string;
}

interface Props {
  onActed?: () => void;
}

export default function AbeChat({ onActed }: Props) {
  const { user, loading } = useAuth();
  const toast = useToast();
  const isAdmin = !loading && user?.role !== 'tenant_user';

  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    api<{ messages: ChatMessage[] }>('/api/agent/chat', { signal: controller.signal })
      .then(r => setMessages(r.messages))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        toast.error(describeError(err));
        setMessages([]);
      });
    return () => controller.abort();
  // toast is stable (context value) — intentionally omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!isAdmin) return null;

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    const optimisticUser: ChatMessage = {
      id: `opt-user-${Date.now()}`,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };
    const thinkingId = `opt-thinking-${Date.now()}`;
    const thinkingRow: ChatMessage = {
      id: thinkingId,
      role: 'abe',
      content: '…',
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...(prev ?? []), optimisticUser, thinkingRow]);
    setInput('');
    setSending(true);

    try {
      const result = await api<{ reply: string }>('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
      const abeMessage: ChatMessage = {
        id: `abe-${Date.now()}`,
        role: 'abe',
        content: result.reply,
        created_at: new Date().toISOString(),
      };
      setMessages(prev =>
        prev ? [...prev.filter(m => m.id !== thinkingId), abeMessage] : [abeMessage],
      );
      onActed?.();
    } catch (err: unknown) {
      setMessages(prev =>
        prev ? prev.filter(m => m.id !== optimisticUser.id && m.id !== thinkingId) : [],
      );
      setInput(text);
      toast.error(describeError(err));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const isEmpty = messages !== null && messages.length === 0;

  return (
    <Card className="flex flex-col gap-0 p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-magenta/15 text-magenta">
          <Bot size={18} />
        </div>
        <span className="text-sm font-semibold text-ink">Talk to Abe</span>
      </div>

      {/* Message list */}
      <div className="flex flex-col gap-3 px-5 py-4 overflow-y-auto max-h-96 min-h-[120px]">
        {messages === null ? (
          <>
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-9 w-1/2 self-end" />
            <Skeleton className="h-9 w-2/3" />
          </>
        ) : isEmpty ? (
          <div className="flex items-start gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-magenta/15 text-magenta mt-0.5">
              <Bot size={14} />
            </div>
            <div className="rounded-2xl rounded-tl-sm bg-surface-raised border border-line px-4 py-2.5 text-sm text-ink max-w-sm">
              Hi — ask me how the win-backs are going, or tell me to adjust how I work.
            </div>
          </div>
        ) : (
          messages.map(msg =>
            msg.role === 'abe' ? (
              <div key={msg.id} className="flex items-start gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-magenta/15 text-magenta mt-0.5">
                  <Bot size={14} />
                </div>
                <div
                  className={`rounded-2xl rounded-tl-sm bg-surface-raised border border-line px-4 py-2.5 text-sm text-ink max-w-sm${
                    msg.content === '…' ? ' text-ink-muted italic' : ''
                  }`}
                >
                  {msg.content === '…' ? 'Abe is thinking…' : msg.content}
                </div>
              </div>
            ) : (
              <div key={msg.id} className="flex justify-end">
                <div className="rounded-2xl rounded-tr-sm bg-brand text-white px-4 py-2.5 text-sm max-w-sm">
                  {msg.content}
                </div>
              </div>
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2 px-5 py-4 border-t border-line">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Abe…"
          disabled={sending || messages === null}
          aria-label="Message Abe"
        />
        <Button
          variant="primary"
          onClick={() => void handleSend()}
          disabled={!input.trim() || sending || messages === null}
          aria-label="Send"
        >
          <Send size={16} />
        </Button>
      </div>
    </Card>
  );
}
