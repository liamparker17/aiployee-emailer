import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@aiployee/ui';
import { useAuth } from '@aiployee/ui';
import { useWizardState } from './state';
import { Input } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function StepTenant() {
  const [state, update] = useWizardState();
  const { user, setActiveTenant } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState(state.tenantName ?? '');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminEmail, setAdminEmail] = useState(user?.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  async function onNext(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const r = await api<{ tenant: { id: string; name: string; slug: string } }>(
        '/api/admin/tenants',
        { method: 'POST', body: JSON.stringify({ name, slug, adminEmail }) },
      );
      await setActiveTenant(r.tenant.id);
      localStorage.setItem('incompleteTenantId', r.tenant.id);
      update({ step: '2', tenantId: r.tenant.id, tenantName: r.tenant.name });
      toast.success('Tenant created.');
    } catch (e: unknown) {
      const er = e as { code?: string; message?: string };
      const msg = er?.code === 'slug_taken'
        ? 'That slug is already taken. Try a different one.'
        : (er?.message ?? 'Failed to create tenant.');
      setErr(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-surface-raised border border-line-strong rounded-2xl p-6">
      <form onSubmit={onNext} className="space-y-5 max-w-md">
        <h2 className="text-xl font-heading font-semibold text-ink">Create a tenant</h2>
        <div>
          <label className="block text-sm mb-1 text-ink-muted">Tenant name</label>
          <Input value={name} onChange={e => setName(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="block text-sm mb-1 text-ink-muted">Slug</label>
          <Input
            value={slug}
            onChange={e => { setSlugTouched(true); setSlug(e.target.value); }}
            pattern="[a-z0-9-]+"
            required
          />
          <p className="text-xs text-ink-dim mt-1">Lowercase, numbers, dashes only.</p>
        </div>
        <div>
          <label className="block text-sm mb-1 text-ink-muted">Tenant admin email</label>
          <Input type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} required />
          <p className="text-xs text-ink-dim mt-1">Will receive an invite to manage this tenant. Default: you.</p>
        </div>
        {err && <div className="text-sm text-error">{err}</div>}
        <div className="flex gap-3">
          <Button type="button" variant="ghost" onClick={() => nav('/')}>Cancel</Button>
          <Button type="submit" disabled={submitting || !name || !slug || !adminEmail}>
            {submitting ? 'Creating…' : 'Next'}
          </Button>
        </div>
      </form>
    </div>
  );
}
