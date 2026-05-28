import { useWizardState } from './onboarding/state';
import { ProgressBar } from './onboarding/ProgressBar';
import { StepTenant } from './onboarding/StepTenant';

export default function Onboarding() {
  const [state] = useWizardState();
  return (
    <div className="min-h-screen p-8 max-w-2xl mx-auto">
      <ProgressBar step={state.step} />
      {state.step === '1' && <StepTenant />}
      {state.step === '2' && <div>Step 2 placeholder — implemented in Task 6.</div>}
      {state.step === '3' && <div>Step 3 placeholder — implemented in Task 7.</div>}
    </div>
  );
}
