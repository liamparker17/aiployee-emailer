#!/usr/bin/env bash
# AIployee Emailer — one-command local dev bootstrap (Linux/macOS)
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@aiployee.co.za}"
ADMIN_PW="${ADMIN_PW:-change-me-now}"
DB_URL="postgres://emailer:emailer@localhost:5433/emailer"

say() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }

# 1. .env
if [ ! -f .env ]; then
  say "Generating .env with random secrets"
  cat > .env <<EOF
NODE_ENV=development
PORT=3000
DATABASE_URL=$DB_URL
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
EMAILER_ENC_KEY=$(openssl rand -base64 32 | tr -d '\n')
PUBLIC_BASE_URL=http://localhost:3000
LOG_LEVEL=info
EOF
fi

# 2. Postgres
say "Starting dev Postgres (docker compose)"
docker compose -f docker/docker-compose.dev.yml up -d
echo "Waiting for Postgres to be healthy..."
for i in {1..30}; do
  if docker compose -f docker/docker-compose.dev.yml exec -T postgres pg_isready -U emailer >/dev/null 2>&1; then break; fi
  sleep 1
done

# 3. Deps
if [ ! -d node_modules ]; then
  say "Installing npm workspaces"
  npm install
fi

# 4. Migrate
say "Running migrations"
DATABASE_URL="$DB_URL" npx -w server node-pg-migrate -m server/migrations up

# 5. Build UI
say "Building web UI into server/public"
npm -w web run build

# 6. Build server (so the bootstrap CLI is available)
say "Building server"
npm -w server run build

# 7. Bootstrap super-admin
say "Creating super-admin: $ADMIN_EMAIL"
DATABASE_URL="$DB_URL" \
SESSION_SECRET="$(grep ^SESSION_SECRET .env | cut -d= -f2-)" \
EMAILER_ENC_KEY="$(grep ^EMAILER_ENC_KEY .env | cut -d= -f2-)" \
PUBLIC_BASE_URL="http://localhost:3000" \
node server/dist/bin/createAdmin.js "$ADMIN_EMAIL" "$ADMIN_PW"

cat <<EOF

\033[1;32m✓ Bootstrap complete.\033[0m

Sign in:    http://localhost:3000     ( $ADMIN_EMAIL / $ADMIN_PW )

Run the API:        npm -w server run dev
Run the UI dev:     npm -w web run dev   (proxies API on :5173)
Run tests:          npm -w server test

EOF
