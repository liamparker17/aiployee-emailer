import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Spinner } from '../components/Skeleton';
import type { AbeGoal } from '../lib/abe';
import AbeHome from '../components/abe/AbeHome';
import HireAbeWizard from '../components/abe/HireAbeWizard';

export default function Abe() {
  const [goal, setGoal] = useState<AbeGoal | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(
    () => api<{ goal: AbeGoal | null }>('/api/agent/goals').then(r => setGoal(r.goal)),
    []
  );
  useEffect(() => { reload().finally(() => setLoading(false)); }, [reload]);

  if (loading) return <div className="p-8"><Spinner /></div>;
  const hired = goal !== null;
  return hired
    ? <AbeHome goal={goal!} onChange={reload} />
    : <HireAbeWizard goal={goal} onHired={reload} />;
}
