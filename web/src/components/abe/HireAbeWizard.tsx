import type { AbeGoal } from '../../lib/abe';

interface Props { goal: AbeGoal | null; onHired: () => void }

export default function HireAbeWizard({ goal: _goal, onHired: _onHired }: Props) {
  return <div>Hire Abe</div>;
}
