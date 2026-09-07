#!/usr/bin/env bash
# Deploy nimiq.subimpact.net from VPS via wrangler (locked standard:
# no GH Actions, no CF Pages Git integration).
set -euo pipefail

source /root/.hermes/.env

echo "==> Build"
npm run build

echo "==> Deploy to Cloudflare Pages"
/root/.hermes/node/bin/wrangler pages deploy dist --project-name=nimiq-subimpact-net --branch=main

echo "==> Done"
