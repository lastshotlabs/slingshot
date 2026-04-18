#!/bin/bash
# Initial certificate provisioning for each domain
for domain in $@; do
  docker compose run --rm certbot certonly \
    --webroot --webroot-path=/var/www/certbot \
    --email $CERTBOT_EMAIL --agree-tos --no-eff-email \
    -d $domain
done
# Reload nginx to pick up new certs
docker compose exec nginx nginx -s reload
