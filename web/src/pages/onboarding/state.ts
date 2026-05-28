import { useSearchParams } from 'react-router-dom';

export type WizardStep = '1' | '2' | '3';

export interface WizardState {
  step: WizardStep;
  tenantId: string | null;
  tenantName: string | null;
  smtpConfigId: string | null;
  senderId: string | null;
  senderEmail: string | null;
  fromDomain: string | null;
}

export function useWizardState(): [WizardState, (patch: Partial<WizardState>) => void] {
  const [sp, setSp] = useSearchParams();
  const state: WizardState = {
    step: (sp.get('step') as WizardStep) || '1',
    tenantId: sp.get('tenantId'),
    tenantName: sp.get('tenantName'),
    smtpConfigId: sp.get('smtpConfigId'),
    senderId: sp.get('senderId'),
    senderEmail: sp.get('senderEmail'),
    fromDomain: sp.get('fromDomain'),
  };
  const update = (patch: Partial<WizardState>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k);
      else next.set(k, String(v));
    }
    setSp(next, { replace: true });
  };
  return [state, update];
}
