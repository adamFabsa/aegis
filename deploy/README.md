# Hosting Aegis

**Live:** https://aegis-beta-nine.vercel.app · database `aegis-hackutd` on SpacetimeDB Maincloud
(dashboard: https://spacetimedb.com/aegis-hackutd).

| Piece | Where |
|---|---|
| Database + game logic (SpacetimeDB module) | SpacetimeDB **Maincloud**, database `aegis-hackutd` |
| Website | **Vercel** project `aegis` (GitHub `adamFabsa/aegis`, Root Directory `web`, Vite); every push to `main` redeploys |
| AI worker (Gemini / Claude) | not hosted: run it from any machine (below), or on a server with `deploy/setup.sh` |

Vercel environment variables (Production + Preview): `VITE_SPACETIME_URI=wss://maincloud.spacetimedb.com`,
`VITE_SPACETIME_DB=aegis-hackutd`. Update the module with
`spacetime publish --no-config aegis-hackutd --server maincloud --module-path spacetimedb --yes` (signed in with
`spacetime login` as the database owner). Reset the hosted game: `spacetime call --no-config aegis-hackutd --server maincloud new_scenario 0`.

AI worker against the hosted database: in `worker/.env` set `SPACETIME_SERVER=https://maincloud.spacetimedb.com`,
`SPACETIME_DATABASE=aegis-hackutd` and the AI key, run `npm --prefix worker start`, then register the identity it prints:
`spacetime call --no-config aegis-hackutd --server maincloud register_worker <identity>`.

## Alternative: one Vultr server for the website and the worker
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
