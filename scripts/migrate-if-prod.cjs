// Runs DB migrations during the Vercel build, production only.
// Preview builds skip it so unmerged branches never migrate the prod DB.
// A failed migration fails the build, so the live deployment stays as it was.
const { execSync } = require('node:child_process');

if (process.env.VERCEL_ENV !== 'production') {
  console.log('[migrate-if-prod] VERCEL_ENV=' + (process.env.VERCEL_ENV || 'unset') + ', skipping migrations');
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.error('[migrate-if-prod] DATABASE_URL missing in production build');
  process.exit(1);
}
console.log('[migrate-if-prod] running migrations');
execSync('npm -w server run migrate', { stdio: 'inherit' });
