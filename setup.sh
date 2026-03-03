#!/bin/bash
set -e

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
echo "Gateway Token: sk-openclaw-token (default)"
echo "PG Connection: postgres://openclaw:openclaw_secret@postgres:5432/openclaw_audit"
