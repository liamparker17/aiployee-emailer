import AbeHome from '../components/abe/AbeHome';

export default function Abe() {
  // Abe's surface is always his analyst home. Setup (OpenAI key, default sender,
  // client recipients/cadence) happens inline via the readiness banner and the
  // line-reporting settings panel — there is no separate win-back onboarding.
  return <AbeHome />;
}
