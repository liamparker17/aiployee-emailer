import { useWizardState } from './onboarding/state';
import { ProgressBar } from './onboarding/ProgressBar';
import { StepTenant } from './onboarding/StepTenant';
import { StepSender } from './onboarding/StepSender';
import { StepTest } from './onboarding/StepTest';

export default function Onboarding() {
  const [state] = useWizardState();
  return (
    <div className="min-h-screen bg-bg p-8 max-w-2xl mx-auto">
      <ProgressBar step={state.step} />
      {state.step === '1' && <StepTenant />}
      {state.step === '2' && <StepSender />}
      {state.step === '3' && <StepTest />}
    </div>
  );
}
