# Enabling the transcript viewer on a public VPS

The viewer serves ticket transcripts — real names, purchase details, appeal
text. So it does **not** get exposed directly. The bot binds to loopback and a
reverse proxy in front terminates TLS.

```
  Internet ──HTTPS──► nginx/Caddy :443 ──HTTP──► Pizza Bot 127.0.0.1:3000
             (TLS)                     (loopback only)
```

`npm run doctor` **fails the run** if it finds plain HTTP bound to a public
interface, so this is enforced rather than merely recommended.

---

## What you need first

- A domain or subdomain pointing at the VPS, e.g. `tickets.yourdomain.com`
  → an **A record** to the VPS's IPv4 address.
- Ports 80 and 443 open.
- Port 3000 **closed** to the outside world. Only the proxy talks to it.

---

## Option A — Caddy (simplest; TLS is automatic)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Replace `/etc/caddy/Caddyfile` with:

```caddyfile
tickets.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate on its own. Nothing else to do.

---

## Option B — nginx + certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/pizzabot`:

```nginx
server {
    listen 80;
    server_name tickets.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Preserve the real client IP — the bot rate-limits per IP, and without
        # this every request appears to come from the proxy itself.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP       $remote_addr;
        proxy_set_header Host            $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Transcript pages are small; fail fast rather than hanging a browser.
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/pizzabot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Issues the certificate and rewrites the config to redirect 80 -> 443
sudo certbot --nginx -d tickets.yourdomain.com
```

Renewal is installed as a systemd timer automatically. Verify with:

```bash
sudo certbot renew --dry-run
```

---

## Firewall

Allow SSH **first** — enabling ufw without it locks you out of the server.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
sudo ufw enable
sudo ufw status
```

`WEB_HOST=127.0.0.1` already means nothing outside the machine can reach port
3000, but denying it explicitly is worth the ten seconds.

---

## Bot configuration

Edit `.env`:

```ini
WEB_ENABLED=true
WEB_PORT=3000
WEB_HOST=127.0.0.1
WEB_BASE_URL=https://tickets.yourdomain.com
WEB_TRUST_PROXY=true
```

**`WEB_TRUST_PROXY=true` only because a proxy is now in front.** Without one,
any client can send `X-Forwarded-For` and reset its own rate limit.

`WEB_PUBLIC_URL` is accepted as an alias for `WEB_BASE_URL` if you prefer that
name. Set one, not both.

Then:

```bash
npm run doctor        # should now show: Transcript viewer  127.0.0.1:3000 -> https://...
pm2 restart pizzabot  # or: systemctl restart pizzabot
```

---

## Verify

```bash
# From the VPS — the bot itself
curl -i http://127.0.0.1:3000/health

# From anywhere — through the proxy
curl -i https://tickets.yourdomain.com/health

# Must be blocked from outside
curl -i --max-time 5 http://YOUR_VPS_IP:3000/health   # expect a timeout
```

Then close a test ticket in Discord. The log message should carry
**🌐 View Transcript** and **📥 Download HTML** instead of an attachment.

---

## Troubleshooting

**Still says "the web viewer was unavailable"**
`WEB_ENABLED` is not exactly `true`, or the bot did not restart. Check the
startup log for `Web server listening` — if you see the warning about
`WEB_ENABLED` instead, the value did not take.

**Bot refuses to start after enabling**
`WEB_BASE_URL` is missing or lacks a scheme. It must start with `https://`.

**`EADDRINUSE` in the log**
Something already holds port 3000. `sudo ss -lptn 'sport = :3000'` to find it,
or pick another `WEB_PORT` and update the proxy to match.

**502 from nginx/Caddy**
The bot is not listening. Check it is running and that `WEB_PORT` matches the
`proxy_pass` port.

**Buttons appear but the link 404s**
The transcript expired (90 days by default), was revoked, or the link is from
before a `/transcript link` rotation. Issue a fresh one with
`/transcript link ticket:<number>`.

---

## Important: this only affects tickets closed from now on

When the viewer is off, no `Transcript` document is written at all — the bot
goes straight to the file fallback. So tickets closed **before** you enable this
have no web transcript and `/transcript link` will say so. Their HTML files are
still attached to the old ticket-log messages, and still on disk in
`transcripts/`.
