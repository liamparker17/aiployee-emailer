import { useState, type FormEvent } from 'react';
import { api, Button, Modal, Input, Field, useToast } from '@aiployee/ui';

interface Created { invite: { mailbox: string; recipientEmail: string; expiresAt: string }; emailSent: boolean; connectUrl: string }

// Admin: email a customer a link that connects their Microsoft 365 mailbox as a sender.
export default function ConnectLinkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [mailbox, setMailbox] = useState('');
  const [recipient, setRecipient] = useState('');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  const reset = () => { setMailbox(''); setRecipient(''); setName(''); setShared(false); setCreated(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<Created>('/api/m365/connect-invites', {
        method: 'POST',
        body: JSON.stringify({
          mailbox: mailbox.trim(), recipientEmail: (recipient || mailbox).trim(),
          displayName: name.trim() || undefined, allowShared: shared,
        }),
      });
      setCreated(r);
      if (r.emailSent) toast.success(`Link emailed to ${r.invite.recipientEmail}`);
      else toast.error('Invite created but the email could not be sent. Copy the link below.');
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} title="Email a connection link">
      {created ? (
        <div className="space-y-3">
          <p>{created.emailSent ? 'Sent to' : 'Not emailed. Create the message yourself for'} <strong>{created.invite.recipientEmail}</strong>. The link connects <strong>{created.invite.mailbox}</strong>, works once and expires in 72 hours.</p>
          <Field label="Link (shown once)"><Input readOnly value={created.connectUrl} onFocus={e => e.currentTarget.select()} /></Field>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(created.connectUrl).then(() => toast.success('Copied'))}>Copy link</Button>
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Mailbox to connect (the sender address)"><Input type="email" required value={mailbox} onChange={e => setMailbox(e.target.value)} placeholder="overflow@customer.co.za" /></Field>
          <Field label="Send the link to"><Input type="email" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="Defaults to the mailbox address" /></Field>
          <Field label="Display name"><Input value={name} onChange={e => setName(e.target.value)} placeholder="Defaults to the mailbox address" /></Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
            Shared mailbox: allow a user with Send As rights to sign in (verified with a test send)
          </label>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" type="button" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Email link'}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
