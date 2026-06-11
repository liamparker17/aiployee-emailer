import { useEffect, useState, type FormEvent } from 'react';
import { MessageCircle, Send, Trash2 } from 'lucide-react';
import { Button, Input, Field, PageHeader, useToast } from '@aiployee/ui';
import {
  getConnection, saveConnection, deleteConnection, testSend, type WaConnection,
} from '../lib/whatsapp';

export default function WhatsApp() {
  const toast = useToast();
  const [conn, setConn] = useState<WaConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [fromNumber, setFromNumber] = useState('');

  const [testTo, setTestTo] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      const { connection } = await getConnection();
      setConn(connection);
      setBaseUrl(connection?.base_url ?? '');
      setFromNumber(connection?.from_number ?? '');
    } catch { /* surfaced via empty state */ }
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { connection } = await saveConnection({
        base_url: baseUrl,
        ...(apiKey ? { api_key: apiKey } : {}),
        from_number: fromNumber || null,
      });
      setConn(connection);
      setApiKey('');
      toast.success('WhatsApp connection saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
    setSaving(false);
  };

  const onDisconnect = async () => {
    if (!window.confirm('Remove the WhatsApp connection? Flows with WhatsApp steps will stop sending.')) return;
    try {
      await deleteConnection();
      setConn(null); setBaseUrl(''); setApiKey(''); setFromNumber('');
      toast.success('WhatsApp connection removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const onTest = async (e: FormEvent) => {
    e.preventDefault();
    setTesting(true);
    try {
      const r = await testSend(testTo, testMessage || undefined);
      if (r.ok) toast.success('Test message sent');
      else toast.error(`Send failed: ${r.error ?? 'unknown error'}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed');
    }
    setTesting(false);
  };

  if (loading) return null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="WhatsApp platform"
        subtitle="Connect this tenant to its Aiployee WhatsApp agent so flows can message over WhatsApp."
      />

      <form onSubmit={onSave} className="flex flex-col gap-4 max-w-xl">
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <MessageCircle size={16} />
          {conn
            ? <span>Connected{conn.last_ok_at ? ` — last successful send ${new Date(conn.last_ok_at).toLocaleString()}` : ''}</span>
            : <span>Not connected yet</span>}
        </div>
        {conn?.last_error && (
          <p className="text-sm text-red-400">Last error: {conn.last_error}</p>
        )}
        <Field label="Platform URL">
          <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://app.aiployee.co.za" required />
        </Field>
        <Field label={conn ? 'API key (leave blank to keep the saved key)' : 'API key'}>
          <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder={conn ? '••••••••  saved' : 'aip_live_…'} required={!conn} />
        </Field>
        <Field label="Default from number (only needed with multiple WhatsApp numbers)">
          <Input value={fromNumber} onChange={e => setFromNumber(e.target.value)} placeholder="+27871234567" />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : conn ? 'Save changes' : 'Connect'}</Button>
          {conn && (
            <Button type="button" variant="ghost" onClick={onDisconnect}>
              <Trash2 size={14} />Disconnect
            </Button>
          )}
        </div>
      </form>

      {conn && (
        <form onSubmit={onTest} className="flex flex-col gap-4 max-w-xl border-t border-line pt-6">
          <h2 className="text-sm font-semibold text-ink">Send a test message</h2>
          <Field label="To (E.164)">
            <Input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="+27821234567" required />
          </Field>
          <Field label="Message (optional)">
            <Input value={testMessage} onChange={e => setTestMessage(e.target.value)}
              placeholder="Test message from the AIployee Command Centre." />
          </Field>
          <div>
            <Button type="submit" disabled={testing}><Send size={14} />{testing ? 'Sending…' : 'Send test'}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
