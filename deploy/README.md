# Hosting Aegis

| Piece | Where |
|---|---|
| Database + game logic (SpacetimeDB module) | SpacetimeDB **Maincloud**, database `aegis-hackutd` |
| Website (static build) | **Vultr** server, served by Caddy with automatic HTTPS |
| AI worker (Gemini / Claude) | same Vultr server, `aegis-worker` systemd service |
| Domain (GoDaddy Registry) | A record → the Vultr server's IP |

Nothing runs on a laptop once this is up.

1. **Database** (laptop, signed in with `spacetime login`):
   `spacetime publish --no-config aegis-hackutd --server maincloud --module-path spacetimedb --yes`
   (`init` loads the Eaton demo map; the signed-in account is the database's administrator.)
2. **Server** (Vultr, Ubuntu 24.04, your SSH key): copy and run `deploy/setup.sh` as root with `DOMAIN=yourdomain`.
3. **DNS** (GoDaddy): `A @ → server IP`, `CNAME www → @` (or `A www → server IP`).
4. **Website** (laptop): `npm run web:build:hosted`, then
   `rsync -a --delete web/dist-hosted/ root@SERVER:/srv/aegis/`.
5. **AI worker** (server): put the key in `/opt/aegis/worker/.env` (see `worker/.env.example`; set
   `SPACETIME_SERVER=https://maincloud.spacetimedb.com`, `SPACETIME_DATABASE=aegis-hackutd`), then
   `systemctl restart aegis-worker`; register its identity once from the laptop (administrator):
   `spacetime call --no-config aegis-hackutd --server maincloud register_worker <worker identity>`
   (the identity is printed in `journalctl -u aegis-worker`).

Update later: re-run step 1 (module) and step 4 (website); `git -C /opt/aegis pull && systemctl restart aegis-worker` for the worker.
