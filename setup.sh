#!/bin/bash
set -e

# Create .env with secrets if not exists
if [ ! -f .env ]; then
  echo "Creating .env with random secrets..."
  OPENCLAW_GATEWAY_TOKEN="$(node -e \"console.log('sk-' + require('crypto').randomBytes(24).toString('hex'))\")"
  OPENCLAW_PG_PASSWORD="$(node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\")"
  cat > .env <<EOF
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
OPENCLAW_PG_PASSWORD=${OPENCLAW_PG_PASSWORD}
EOF
else
  echo ".env already exists, skipping creation."
fi

# Create config.json if not exists
if [ ! -f config.json ]; then
  echo "Creating config.json from config.example.json..."
  cp config.example.json config.json
else
  echo "config.json already exists, skipping creation."
fi

# Create workspace directory if not exists
if [ ! -d workspace ]; then
  mkdir -p workspace
  echo "Created workspace directory."
fi

# Build and start services
echo "Starting OpenClaw PG Audit..."
docker compose -f docker-compose.pg.yml up -d --build

echo "Deployment complete!"
echo "Gateway URL: http://localhost:18789"
echo "Secrets are stored in .env (OPENCLAW_GATEWAY_TOKEN, OPENCLAW_PG_PASSWORD)."
