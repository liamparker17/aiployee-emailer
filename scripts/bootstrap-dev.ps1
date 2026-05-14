# AIployee Emailer — one-command local dev bootstrap (Windows PowerShell)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$AdminEmail = if ($env:ADMIN_EMAIL) { $env:ADMIN_EMAIL } else { 'admin@aiployee.co.za' }
$AdminPw    = if ($env:ADMIN_PW)    { $env:ADMIN_PW }    else { 'change-me-now' }
$DbUrl      = 'postgres://emailer:emailer@localhost:5433/emailer'

function Say($msg) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }

function RandomBase64($bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b)
}

# 1. .env
if (-not (Test-Path .env)) {
  Say 'Generating .env with random secrets'
  @"
NODE_ENV=development
PORT=3000
DATABASE_URL=$DbUrl
SESSION_SECRET=$(RandomBase64 48)
EMAILER_ENC_KEY=$(RandomBase64 32)
PUBLIC_BASE_URL=http://localhost:3000
LOG_LEVEL=info
"@ | Set-Content -Path .env -Encoding utf8
}

# 2. Postgres
Say 'Starting dev Postgres (docker compose)'
docker compose -f docker/docker-compose.dev.yml up -d
Write-Host 'Waiting for Postgres...'
for ($i = 0; $i -lt 30; $i++) {
  $ok = $true
  try { docker compose -f docker/docker-compose.dev.yml exec -T postgres pg_isready -U emailer | Out-Null } catch { $ok = $false }
  if ($ok) { break }
  Start-Sleep -Seconds 1
}

# 3. Deps
if (-not (Test-Path node_modules)) {
  Say 'Installing npm workspaces'
  npm install
}

# 4. Migrate
Say 'Running migrations'
$env:DATABASE_URL = $DbUrl
npx -w server node-pg-migrate -m server/migrations up

# 5. Build UI
Say 'Building web UI into server/public'
npm -w web run build

# 6. Build server
Say 'Building server'
npm -w server run build

# 7. Bootstrap super-admin
Say "Creating super-admin: $AdminEmail"
$envFile = Get-Content .env
$env:SESSION_SECRET = ($envFile | Where-Object { $_ -like 'SESSION_SECRET=*' }) -replace '^SESSION_SECRET=', ''
$env:EMAILER_ENC_KEY = ($envFile | Where-Object { $_ -like 'EMAILER_ENC_KEY=*' }) -replace '^EMAILER_ENC_KEY=', ''
$env:PUBLIC_BASE_URL = 'http://localhost:3000'
node server/dist/bin/createAdmin.js $AdminEmail $AdminPw

Write-Host "`n✓ Bootstrap complete." -ForegroundColor Green
Write-Host ""
Write-Host "Sign in:    http://localhost:3000     ( $AdminEmail / $AdminPw )"
Write-Host ""
Write-Host "Run the API:        npm -w server run dev"
Write-Host "Run the UI dev:     npm -w web run dev   (proxies API on :5173)"
Write-Host "Run tests:          npm -w server test"
