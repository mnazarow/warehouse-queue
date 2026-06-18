#!/bin/sh
# Bootstrap Let's Encrypt certificates for the nginx service.
# Run ONCE after `docker compose build`, before normal `docker compose up -d`.
#
#   cd warehouse-queue
#   cp .env.example .env   # then edit DOMAIN / CERTBOT_EMAIL / passwords
#   ./deploy/init-letsencrypt.sh
#
# Idempotent-ish: re-running will offer to replace existing certificates.
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

# Load DOMAIN and CERTBOT_EMAIL from .env
DOMAIN=$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2-)
EMAIL=$(grep -E '^CERTBOT_EMAIL=' .env | head -1 | cut -d= -f2-)

if [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "example.com" ]; then
  echo "ERROR: set a real DOMAIN in .env" >&2
  exit 1
fi

# Use staging certs while testing to avoid Let's Encrypt rate limits:
#   STAGING=1 ./deploy/init-letsencrypt.sh
STAGING_ARG=""
if [ "${STAGING:-0}" = "1" ]; then STAGING_ARG="--staging"; fi

COMPOSE="docker compose"
CERT_PATH="/etc/letsencrypt/live/$DOMAIN"

echo "### Creating a temporary self-signed certificate for $DOMAIN ..."
$COMPOSE run --rm --entrypoint "/bin/sh -c '\
  mkdir -p $CERT_PATH && \
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout $CERT_PATH/privkey.pem -out $CERT_PATH/fullchain.pem \
    -subj /CN=localhost'" certbot

echo "### Starting nginx ..."
$COMPOSE up -d nginx

echo "### Deleting the temporary certificate ..."
$COMPOSE run --rm --entrypoint "/bin/sh -c 'rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf'" certbot

echo "### Requesting the real Let's Encrypt certificate for $DOMAIN ..."
EMAIL_ARG="--register-unsafely-without-email"
if [ -n "${EMAIL:-}" ] && [ "$EMAIL" != "admin@example.com" ]; then EMAIL_ARG="--email $EMAIL"; fi

$COMPOSE run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $STAGING_ARG $EMAIL_ARG \
    -d $DOMAIN \
    --rsa-key-size 4096 \
    --agree-tos --no-eff-email --non-interactive" certbot

echo "### Reloading nginx ..."
$COMPOSE exec nginx nginx -s reload || $COMPOSE restart nginx

echo "### Done. Bring the whole stack up with: docker compose up -d"
