#!/bin/bash
set -euo pipefail

# ============================================================
# Warehouse Queue System — Deploy Script
# ============================================================
# Usage:
#   ./deploy.sh                          # install & start
#   ./deploy.sh --help                   # show this help
#   ./deploy.sh --no-pg                  # skip PostgreSQL setup
#   ./deploy.sh --no-redis               # skip Redis setup
#   ./deploy.sh --no-nginx               # skip nginx / certbot
#   ./deploy.sh --port 3000              # custom internal port
#   ./deploy.sh --systemd                # install as systemd service
#   ./deploy.sh --domain foo.com         # domain for nginx + SSL
#   ./deploy.sh --domain foo.com --staging  # certbot staging mode
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

SETUP_PG=true
SETUP_REDIS=true
SETUP_NGINX=true
CUSTOM_PORT=""
USE_SYSTEMD=false
DOMAIN=""
STAGING=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      sed -n '/^# Usage:/,/^SCRIPT_DIR/p' "$0" | head -n -1 | sed 's/^# //'
      exit 0
      ;;
    --no-pg)    SETUP_PG=false; shift ;;
    --no-redis) SETUP_REDIS=false; shift ;;
    --no-nginx) SETUP_NGINX=false; shift ;;
    --port)     CUSTOM_PORT="$2"; shift 2 ;;
    --systemd)  USE_SYSTEMD=true; shift ;;
    --domain)   DOMAIN="$2"; shift 2 ;;
    --staging)  STAGING=true; shift ;;
    *)          err "Unknown option: $1"; exit 1 ;;
  esac
done

if [ "$SETUP_NGINX" = true ] && [ -z "$DOMAIN" ]; then
  warn "--domain not specified, nginx will be installed but SSL will be skipped"
  warn "  To enable HTTPS, re-run: ./deploy.sh --domain example.com"
fi

if [ "$SETUP_NGINX" = false ] && [ -n "$DOMAIN" ]; then
  warn "--domain is ignored when --no-nginx is set"
fi

FINAL_PORT="${CUSTOM_PORT:-3000}"

# -----------------------------------------------------------
# Pre-flight checks
# -----------------------------------------------------------
info "Pre-flight checks..."

NODE_REQUIRED=12
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt "$NODE_REQUIRED" ]; then
  err "Node.js $NODE_REQUIRED+ required (found v$(node --version 2>/dev/null || echo 'not installed'))"
  info "Install via: apt install nodejs npm  (Ubuntu/Debian)"
  exit 1
fi
log "Node.js $(node --version)"

NPM_VERSION=$(npm --version 2>/dev/null || echo '0')
info "npm v$NPM_VERSION"

# -----------------------------------------------------------
# Install npm dependencies
# -----------------------------------------------------------
info "Installing npm dependencies..."
if [ ! -d "node_modules" ]; then
  npm install --production 2>&1 | tail -3
  log "npm dependencies installed"
else
  warn "node_modules already exists, skipping npm install"
  info "  Run 'npm install' manually to update"
fi

# -----------------------------------------------------------
# Create .env if missing
# -----------------------------------------------------------
if [ ! -f ".env" ] && [ -n "$CUSTOM_PORT" ]; then
  echo "PORT=$CUSTOM_PORT" > .env
  log "Created .env with PORT=$CUSTOM_PORT"
fi

# -----------------------------------------------------------
# PostgreSQL setup
# -----------------------------------------------------------
if [ "$SETUP_PG" = true ]; then
  info "Checking PostgreSQL..."

  if command -v psql &>/dev/null; then
    PG_VERSION=$(psql --version | grep -oP '\d+' | head -1)
    log "PostgreSQL $PG_VERSION available"

    if systemctl is-active --quiet postgresql 2>/dev/null; then
      info "PostgreSQL service is running"
    else
      warn "PostgreSQL service is not running"
      info "  Start: sudo systemctl start postgresql"
    fi
  else
    warn "psql not found — skipping PostgreSQL setup"
    warn "  Install: sudo apt install postgresql postgresql-client"
    SETUP_PG=false
  fi
else
  info "PostgreSQL setup skipped (--no-pg)"
fi

# -----------------------------------------------------------
# Redis setup
# -----------------------------------------------------------
if [ "$SETUP_REDIS" = true ]; then
  info "Checking Redis..."

  if command -v redis-cli &>/dev/null; then
    if redis-cli ping 2>/dev/null | grep -q PONG; then
      log "Redis is running"
    else
      warn "redis-cli found but can't connect"
      SETUP_REDIS=false
    fi
  else
    warn "redis-cli not found — skipping Redis setup"
    warn "  Install: sudo apt install redis-server"
    SETUP_REDIS=false
  fi
else
  info "Redis setup skipped (--no-redis)"
fi

# -----------------------------------------------------------
# Database initialization (first start creates warehouse.db)
# -----------------------------------------------------------
info "Initializing database..."
if [ -f "warehouse.db" ]; then
  SIZE=$(du -h warehouse.db | cut -f1)
  log "SQLite database exists ($SIZE)"
else
  warn "warehouse.db not found — will be created on first server start"
fi

# -----------------------------------------------------------
# Run database migrations (inline, executed on server start)
# -----------------------------------------------------------
info "Database migrations are applied automatically on server startup"

# -----------------------------------------------------------
# Nginx + Certbot setup
# -----------------------------------------------------------
if [ "$SETUP_NGINX" = true ]; then
  info "Nginx setup..."

  if ! command -v nginx &>/dev/null; then
    info "Installing nginx..."
    sudo apt-get update -qq && sudo apt-get install -y -qq nginx
    log "Nginx installed"
  else
    log "Nginx already installed ($(nginx -v 2>&1 | grep -oP 'nginx/\S+'))"
  fi

  if [ -n "$DOMAIN" ]; then
    if ! command -v certbot &>/dev/null; then
      info "Installing certbot..."
      sudo apt-get install -y -qq certbot python3-certbot-nginx
      log "Certbot installed"
    else
      log "Certbot already installed"
    fi
  fi

  NGINX_CONF="/etc/nginx/sites-available/warehouse-queue"
  NGINX_ENABLED="/etc/nginx/sites-enabled/warehouse-queue"

  info "Writing nginx config for domain '${DOMAIN:-_}'..."
  sudo tee "$NGINX_CONF" > /dev/null <<NGINX
upstream warehouse_app {
    server 127.0.0.1:$FINAL_PORT;
    keepalive 64;
}

NGINX
  if [ -n "$DOMAIN" ]; then
    sudo tee -a "$NGINX_CONF" > /dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size 20m;

    location / {
        proxy_pass http://warehouse_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
  else
    sudo tee -a "$NGINX_CONF" > /dev/null <<NGINX
server {
    listen 80;
    server_name _;

    client_max_body_size 20m;

    location / {
        proxy_pass http://warehouse_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
  fi

  if [ ! -L "$NGINX_ENABLED" ]; then
    sudo ln -sf "$NGINX_CONF" "$NGINX_ENABLED"
    log "Nginx site enabled"
  fi

  sudo nginx -t 2>&1 | head -1
  sudo systemctl reload nginx || sudo systemctl restart nginx
  log "Nginx reloaded"

  # --- Obtain SSL certificate ---
  if [ -n "$DOMAIN" ]; then
    CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
    if [ -d "$CERT_DIR" ]; then
      log "SSL certificate already exists for $DOMAIN"
      info "  Expiry: $(sudo openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" 2>/dev/null | cut -d= -f2)"
    else
      info "Obtaining SSL certificate for $DOMAIN..."
      CERTBOT_ARGS="--nginx --non-interactive --agree-tos --email admin@$DOMAIN"
      if [ "$STAGING" = true ]; then
        CERTBOT_ARGS="$CERTBOT_ARGS --staging"
        warn "Using certbot STAGING — certificate will not be trusted"
      fi
      if sudo certbot $CERTBOT_ARGS -d "$DOMAIN"; then
        log "SSL certificate obtained for $DOMAIN"
      else
        err "Certbot failed — check DNS records for $DOMAIN"
        warn "  Ensure A/AAAA record points to this server's public IP"
      fi
    fi

    # --- Auto-renewal ---
    if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
      (crontab -l 2>/dev/null; echo "0 3 * * * /usr/bin/certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
      log "Certbot auto-renewal cron installed (daily 3:00 AM)"
    else
      info "Certbot auto-renewal already scheduled"
    fi
  fi

  # --- Open ports 80/443 in firewall ---
  if command -v ufw &>/dev/null; then
    if ufw status 2>/dev/null | grep -q active; then
      for p in 80 443; do
        if ! ufw status | grep -q "^$p"; then
          sudo ufw allow "$p/tcp" > /dev/null
          log "Firewall: port $p opened"
        fi
      done
    fi
  fi
fi

# -----------------------------------------------------------
# Firewall check (internal port)
# -----------------------------------------------------------
if command -v ufw &>/dev/null; then
  if ufw status 2>/dev/null | grep -q active; then
    if ! ufw status | grep -q "$FINAL_PORT"; then
      info "Internal port $FINAL_PORT — not opened (nginx proxies from 80/443)"
    fi
  fi
fi

# -----------------------------------------------------------
# systemd service installation
# -----------------------------------------------------------
if [ "$USE_SYSTEMD" = true ]; then
  SERVICE_NAME="warehouse-queue"
  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  NODE_BIN=$(which node)

  if [ -f "$SERVICE_FILE" ]; then
    warn "systemd service already exists at $SERVICE_FILE"
    info "  Restart: sudo systemctl restart $SERVICE_NAME"
  else
    info "Creating systemd service..."
    BIND="0.0.0.0"
    if [ -n "$DOMAIN" ] || [ "$SETUP_NGINX" = true ]; then
      BIND="127.0.0.1"
    fi
    sudo tee "$SERVICE_FILE" > /dev/null <<SERVICE
[Unit]
Description=Warehouse Queue System
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOST=$BIND
Environment=PORT=$FINAL_PORT

[Install]
WantedBy=multi-user.target
SERVICE
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    log "systemd service created at $SERVICE_FILE"
    info "  Start: sudo systemctl start $SERVICE_NAME"
  fi
fi

# -----------------------------------------------------------
# Start server (if not running via systemd)
# -----------------------------------------------------------
if [ "$USE_SYSTEMD" = false ]; then
  if command -v screen &>/dev/null; then
    if screen -list 2>/dev/null | grep -q warehouse; then
      warn "Server already running in screen session 'warehouse'"
      info "  Attach: screen -r warehouse"
      info "  Restart: screen -S warehouse -X quit && ./deploy.sh"
    else
      screen -dmS warehouse bash -c "cd '$SCRIPT_DIR' && node server.js"
      sleep 2
      if curl -sfo /dev/null "http://localhost:$FINAL_PORT/"; then
        log "Server started on http://localhost:$FINAL_PORT"
        info "  Attach: screen -r warehouse"
        info "  Detach: Ctrl+A, D"
      else
        err "Server failed to start — check logs"
        exit 1
      fi
    fi
  else
    warn "screen not found — starting in background (nohup)"
    nohup node server.js > server.log 2>&1 &
    sleep 2
    if curl -sfo /dev/null "http://localhost:$FINAL_PORT/"; then
      log "Server started on http://localhost:$FINAL_PORT (PID $!)"
      info "  Logs: tail -f server.log"
    else
      err "Server failed to start — check server.log"
      exit 1
    fi
  fi
fi

# -----------------------------------------------------------
# Summary
# -----------------------------------------------------------
echo ""
echo -e "${CYAN}══════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Warehouse Queue System — Deployed${NC}"
echo -e "${CYAN}══════════════════════════════════════════════${NC}"
echo ""

if [ -n "$DOMAIN" ]; then
  echo -e "  ${GREEN}https://$DOMAIN${NC}"
  echo -e "  ${GREEN}https://$DOMAIN/manager.html${NC}"
elif [ "$SETUP_NGINX" = true ]; then
  echo -e "  ${GREEN}http://localhost${NC}"
  echo -e "  ${GREEN}http://localhost/manager.html${NC}"
fi
echo -e "  Direct:    ${GREEN}http://localhost:$FINAL_PORT${NC}"
echo -e "  Login:     admin / admin123"
echo ""
if [ "$SETUP_PG" = true ]; then
  echo -e "  PostgreSQL: ${GREEN}available${NC}"
  echo -e "    Settings → PostgreSQL → configure in dashboard"
fi
if [ "$SETUP_REDIS" = true ]; then
  echo -e "  Redis:      ${GREEN}available${NC}"
  echo -e "    Settings → Redis → enable in dashboard"
fi
if [ -n "$DOMAIN" ]; then
  CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
  if [ -d "$CERT_DIR" ]; then
    EXPIRY=$(sudo openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" 2>/dev/null | cut -d= -f2)
    echo -e "  SSL:        ${GREEN}active${NC} (expires $EXPIRY)"
  else
    echo -e "  SSL:        ${YELLOW}pending — run certbot manually${NC}"
  fi
fi
echo ""
echo -e "  Manage:"
if [ "$USE_SYSTEMD" = true ]; then
  BIND="0.0.0.0"
  if [ -n "$DOMAIN" ] || [ "$SETUP_NGINX" = true ]; then
    BIND="127.0.0.1"
  fi
  echo -e "    sudo systemctl start|stop|restart ${SERVICE_NAME}"
  echo -e "    sudo journalctl -u ${SERVICE_NAME} -f"
  echo -e "    App listens on ${CYAN}http://$BIND:$FINAL_PORT${NC}"
  if [ -n "$DOMAIN" ] || [ "$SETUP_NGINX" = true ]; then
    echo -e "    Nginx proxies to app → ${CYAN}http://$BIND:$FINAL_PORT${NC}"
  fi
else
  echo -e "    screen -r warehouse        (attach)"
  echo -e "    screen -S warehouse -X quit (stop)"
fi
echo ""
echo -e "${CYAN}══════════════════════════════════════════════${NC}"
