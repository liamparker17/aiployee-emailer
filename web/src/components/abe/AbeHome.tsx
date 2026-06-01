import type { AbeGoal } from '../../lib/abe';

interface Props { goal: AbeGoal; onChange: () => void }

export default function AbeHome({ goal: _goal, onChange: _onChange }: Props) {
  return <div>Abe home</div>;
}
