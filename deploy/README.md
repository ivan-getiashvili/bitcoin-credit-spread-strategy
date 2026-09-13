# Putting the bot and dashboards online

The bot serves two dashboards from the same live data, both on 127.0.0.1 only:

| Port | Who | What |
|---|---|---|
| 4192 (`publicPort`) | anyone | read-only: equity curve, positions, deals, metrics. No buttons, and no routes that change anything |
| 4191 (`port`) | Ivan only | the same page with the trade buttons and coin switches |

Cloudflare Tunnel connects them to the domain without opening any port on the server.
Cloudflare Access puts a login in front of the private one.

## Steps

Steps marked **Ivan** involve payment, accounts or secrets, so Ivan does them. The rest
Claude can do over SSH from the Mac.

1. **Ivan — domain.** Buy it on Cloudflare Registrar (Domain Registration → Register).
   putspread.com is taken; putspread.net, putspread.io and putspread.app were free on
   2026-09-13.
2. **Ivan — server.** Create a small Linux server (for example Hetzner CX22, Ubuntu
   24.04). Add the Mac's SSH public key (`~/.ssh/id_ed25519.pub`) when creating it, then
   share the server's IP address.
3. **Claude — install.**
   - Install Node.js 24 and create a `putspread` user.
   - Copy the project to `/opt/putspread`, leaving out `.env`, `data/history*`
     and `data/*.lock`.
   - Install `deploy/putspread-bot.service`.
4. **Ivan — keys on the server.** Put the Deribit test keys in `/opt/putspread/.env`
   (mode 600), for example by copying the Mac's `.env` with `scp`. Never paste keys into
   chat.
5. **Ivan — tunnel.** Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create
   tunnel, then run the install command it shows on the server (it contains a secret
   token). Add two public hostnames:
   - `<domain>` → `http://127.0.0.1:4192`
   - `control.<domain>` → `http://127.0.0.1:4191`
6. **Ivan — login.** Zero Trust → Access → Applications → Add a self-hosted app for
   `control.<domain>`, with a policy that allows only your email.
7. **Claude — finish.**
   - Set `"controlOrigins": ["https://control.<domain>"]` in `bot.config.json`.
   - Stop the copy running on the Mac (only one bot may trade an account).
   - Start the service with `systemctl enable --now putspread-bot`.
   - Check both addresses: the public one read-only, the control one behind the login.
