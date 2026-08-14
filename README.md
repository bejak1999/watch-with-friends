<div align="center">

# 🍿 Watch With Friends

**Watch YouTube, Vimeo, Twitch and your own videos together — perfectly in sync.**

A self-hosted alternative to Watch2Gether. No ads, no accounts you don't control,
no random strangers. Just you, your friends, and a shared play button.

![Node](https://img.shields.io/badge/Node-22-339933?style=flat-square&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embedded-003B57?style=flat-square&logo=sqlite&logoColor=white)
![Self-hosted](https://img.shields.io/badge/self--hosted-yes-8A2BE2?style=flat-square)
[![Container image](https://img.shields.io/badge/ghcr.io-watch--with--friends-2496ED?style=flat-square&logo=github)](https://github.com/bejak1999/watch-with-friends/pkgs/container/watch-with-friends)

</div>

---

## ✨ What it does

| | |
|---|---|
| 🔐 | **Invite-code registration.** One admin account generates codes. Friends sign up with `code + username + password`, then log in with just username and password. |
| 🎬 | **Watch rooms.** Create as many as you like, each with its own invite link. Public rooms are listed for everyone; private ones only work via the link. |
| ⏱️ | **Real sync.** The server owns the clock. Clients measure their own latency, then correct drift continuously — nudging speed for small gaps, seeking for big ones. |
| ⏸️ | **Wait for everyone.** Somebody buffering? The room pauses on its own and resumes together. No more "wait, pause, I'm behind". |
| 📋 | **Persistent queue + playlists.** Queues survive restarts. Save any queue as a playlist and drop it into any room later. |
| 💬 | **Chat & presence.** See who's online, who's buffering, and how far off the room clock each person is. |
| 👑 | **Host controls.** Let everyone drive, or lock playback and the queue to hosts. Promote, remove, or block people. |
| 🛡️ | **Brute-force protection.** Three free mistakes, then every wrong password doubles the wait — 2s, 4s, 8s… up to 15 minutes. |
| 🎨 | **Themes.** Dark, Midnight (OLED black) and Light, a pickable accent colour, and three densities — saved to your account. |
| 📱 | **Works on phones.** Responsive layout, theater mode, fullscreen, keyboard shortcuts. |

## 📺 Supported sources

| Source | Support |
|---|---|
| ▶️ **YouTube** | Videos, Shorts, and full playlist import |
| 🔵 **Vimeo** | Public and embeddable videos |
| 🟣 **Twitch** | VODs sync normally · live channels sync to the live edge |
| 🔗 **Direct links** | `.mp4` · `.webm` · `.mkv` · `.m3u8` (HLS) · audio files |
| 📤 **Uploads** | Streamed from your own server, with admin-set storage quotas |

> [!NOTE]
> No DRM support — Netflix, Disney+ and friends will not work. That's a browser
> restriction, not something any self-hosted app can get around.

---

## 🚀 Install

Nothing is required except Docker. No config file, no secrets to generate — the
server creates its own session key and prints a random admin password on first start.

```bash
docker run -d --name watch-with-friends -p 8080:8080 -v wwf-data:/data --restart unless-stopped ghcr.io/bejak1999/watch-with-friends:latest
```

Get your password, then open `http://<server-ip>:8080`:

```bash
docker logs watch-with-friends
```

Sign in as `admin`, **change the password** under Settings, then go to
**Admin → Codes** to generate registration codes for your friends. That's the whole
setup. 🎉

> [!WARNING]
> **`ADMIN_USERNAME` and `ADMIN_PASSWORD` only work on a brand-new database.**
> Once an account exists they are ignored — otherwise anyone who could edit the
> compose file could take over an existing account. Setting them after the first
> start and then failing to sign in is the most common trip-up; the container log
> now says so explicitly. To change a password afterwards, use
> [🆘 Locked out?](#-locked-out) below.

<details>
<summary><b>Prefer Docker Compose?</b> One file, still no <code>.env</code> needed.</summary>

```bash
curl -O https://raw.githubusercontent.com/bejak1999/watch-with-friends/main/docker-compose.ghcr.yml
docker compose -f docker-compose.ghcr.yml up -d
```

Update later:
```bash
docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d
```

Want to set things explicitly — a fixed admin password, a host path for the data, a
different port? Drop a `.env` next to it; every variable is optional:

```bash
curl -o .env https://raw.githubusercontent.com/bejak1999/watch-with-friends/main/.env.example
```
</details>

<details>
<summary><b>Build from source instead</b> — guided script or plain compose.</summary>

```bash
git clone https://github.com/bejak1999/watch-with-friends.git
cd watch-with-friends
./install.sh
```

`install.sh` walks you through domain, port, admin password and data location, then
builds and starts everything. Re-run it after `git pull` to update; it keeps your
existing `.env` and data.

Or skip the script entirely:

```bash
docker compose up -d --build
```
</details>

<details>
<summary><b>Pin a specific version</b> instead of tracking <code>latest</code>.</summary>

Every commit publishes `sha-<short>`, and git tags like `v1.2.0` publish `1.2.0`:

```bash
docker run -d --name watch-with-friends -p 8080:8080 -v wwf-data:/data ghcr.io/bejak1999/watch-with-friends:sha-568ba31
```

With compose, set `IMAGE_TAG` in `.env`.
</details>

---

## 🌐 Reaching it from your domain

### Cloudflare Tunnel

The app is one HTTP service that also speaks WebSocket. Cloudflare Tunnel handles
WebSockets on every plan, so a single public hostname is all you need.

**Zero Trust → Networks → Tunnels → your tunnel → Public Hostname:**

| Field | Value |
|---|---|
| Subdomain | `watch` |
| Domain | `your-domain.tld` |
| Service type | `HTTP` |
| URL | `<nas-ip>:8080` — or `localhost:8080` if `cloudflared` runs on the same box |

Or in `config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: watch.your-domain.tld
    service: http://127.0.0.1:8080
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
```

> [!IMPORTANT]
> **`TRUST_PROXY=true` is required.** Without it the session cookie is not marked
> `Secure`, and sign-in fails silently over HTTPS. It is the default in the compose
> files — just don't remove it.

<details>
<summary>⚠️ Cloudflare gotchas worth knowing</summary>

- **100 MB upload cap on the free plan.** Large file uploads won't fit through the
  tunnel. Everything else works fine — upload big files over LAN, or use a paid plan.
- **Turn off Rocket Loader** and aggressive HTML minification for this hostname; they
  break the embedded players.
- **Using Cloudflare Access?** Add a bypass or service token for `/socket.io`,
  otherwise WebSocket upgrades get intercepted and nothing syncs.
- **Twitch embeds** need the hostname declared as a `parent`. The client sends
  `window.location.hostname` automatically, so your tunnel domain just works.
</details>

---

## 🖥️ TrueNAS SCALE

<details>
<summary><b>Custom App (recommended)</b></summary>

1. Create a dataset for the data, e.g. `tank/apps/wwf`, and make it writable by the
   container user:
   ```bash
   chown -R 1000:1000 /mnt/tank/apps/wwf
   ```
2. **Apps → Discover Apps → Custom App**:
   - **Image**: `ghcr.io/bejak1999/watch-with-friends:latest` — the package is
     public, so leave *Image pull secrets* empty
   - **Port**: container `8080` → node port, e.g. `30080`
   - **Storage**: host path `/mnt/tank/apps/wwf` → mount path `/data`
   - **Environment**: all optional, but useful here:

     | Name | Value |
     |---|---|
     | `ADMIN_USERNAME` | `admin` |
     | `ADMIN_PASSWORD` | your first password |
     | `TRUST_PROXY` | `true` |
     | `YOUTUBE_API_KEY` | optional |
     | `TZ` | `Europe/Berlin` |

3. Point your Cloudflare Tunnel at the node port.
</details>

<details>
<summary><b>Docker Compose from the TrueNAS shell</b></summary>

Clone to a dataset, point the volume at a host path in `docker-compose.yml`:

```yaml
    volumes:
      - /mnt/tank/apps/wwf:/data
```

then `docker compose up -d --build`.
</details>

---

## 🔑 YouTube API key (optional)

Pasting normal video links works without one. A key unlocks **playlist import** and
**in-app search**.

1. 🌐 <https://console.cloud.google.com> → create a project
2. 📚 **APIs & Services → Library** → enable **YouTube Data API v3**
3. 🔐 **Credentials → Create credentials → API key**
4. 🛡️ Restrict it to the YouTube Data API
5. 📋 Paste it into **Admin → Settings → Integrations** (or set `YOUTUBE_API_KEY`)

Free quota is 10,000 units/day ≈ 100 playlist imports or searches.

---

## 🆘 Locked out?

Every recovery path runs inside the container — you never lose data.

```bash
# Who exists, who is an admin, and which accounts are in back-off
docker exec -it watch-with-friends node server/dist/admin-cli.js list

# Set a password, grant admin, re-enable the account, clear its lockout
docker exec -it watch-with-friends node server/dist/admin-cli.js reset admin 'my new password'

# Clear only the failed-login back-off
docker exec -it watch-with-friends node server/dist/admin-cli.js unlock admin

# Add a brand-new admin account
docker exec -it watch-with-friends node server/dist/admin-cli.js create benni 'my new password'
```

Common causes:

| Symptom | Cause | Fix |
|---|---|---|
| "Wrong username or password" right after setting `ADMIN_*` | Those only apply to an empty database | `admin-cli.js reset` |
| Forgot the generated password | It was printed once, on first start | `admin-cli.js reset` |
| "Too many failed attempts" | Brute-force back-off | Wait it out, or `admin-cli.js unlock` |
| Password containing `$` is truncated | Docker Compose expands `$…` in `.env` | Single-quote it (`ADMIN_PASSWORD='a$b'`) or double the `$$`. A backslash does **not** work. |

---

## 🛡️ Security

Since this is exposed to the internet through your tunnel, a few things are worth
knowing about.

**Login back-off.** Credential guessing gets exponentially slower:

| Failed attempts | Wait before the next try |
|---|---|
| 1 – 3 | none — typos are free |
| 4 | 2 seconds |
| 5 | 4 seconds |
| 6 | 8 seconds |
| 7 | 16 seconds |
| … | doubling each time |
| 13+ | capped at 15 minutes |

- Counters live in SQLite, so **restarting the container does not reset them**.
- Two independent counters guard each attempt: one keyed on the **account**, which
  can't be forged, and one on the **caller's address**, which stops a single host
  spraying many usernames. Rotating IPs does not unlock a targeted account.
- A successful sign-in clears the counter; so does an hour of quiet.
- The same back-off protects **registration-code guessing**, the code-validity
  check, and the change-password form.
- Locked yourself out? **Admin → Users → Failed sign-ins** lists every counter and
  clears any of them instantly.

**Client addresses behind a proxy.** `X-Forwarded-For` is attacker-controllable, so
the address counter prefers `CF-Connecting-IP` (which Cloudflare overwrites at its
edge) and otherwise takes the *right-most* forwarded hop — the one your own proxy
appended — rather than the spoofable left-most one.

**Passwords** are hashed with scrypt (N=16384, r=8, p=1) and a per-user random salt.
Sessions are signed JWTs in an `httpOnly`, `SameSite=Lax` cookie, marked `Secure`
whenever the request arrives over HTTPS.

> [!TIP]
> Want a second lock on the door? Put **Cloudflare Access** in front of the hostname
> for email-based auth before anyone even reaches the login page. Just remember to
> bypass `/socket.io`, or WebSocket upgrades get intercepted.

---

## ⚙️ Environment variables

**None of these are required** — the defaults are what a plain `docker run` uses.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `/data` | Database, uploads, generated session key |
| `SESSION_SECRET` | generated into `DATA_DIR` | Signs session cookies |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `TRUST_PROXY` | `true` | Honour `X-Forwarded-*` from the tunnel |
| `ADMIN_USERNAME` | `admin` | Bootstrap admin, first start only |
| `ADMIN_PASSWORD` | generated + logged | Bootstrap admin password |
| `YOUTUBE_API_KEY` | — | Overridden by a key saved in the admin panel |
| `CLIENT_DIR` | `../client/dist` | Where the built UI lives |

---

## ⌨️ Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | ⏯️ Play or pause |
| `←` `→` | ⏪ Skip 5 seconds |
| `Shift` + `←` `→` | ⏩ Skip 30 seconds |
| `N` | ⏭️ Next in queue |
| `M` | 🔇 Mute |
| `F` | 🖥️ Fullscreen |
| `T` | 🎦 Theater mode |

---

## 🧑‍💻 Development

```bash
npm install
npm run dev
```

- 🔌 API on `http://localhost:8080`
- 🎨 UI on `http://localhost:5173` (Vite proxies `/api` and `/socket.io`)
- 💾 Dev database in `./data`
- 🔑 Admin password printed on first start

```bash
npm run typecheck   # both workspaces
npm run build       # production build
npm start           # run the production build
```

<details>
<summary>🏗️ How the sync actually works</summary>

The server is the single source of truth. It stores `position`, `isPlaying`, `rate`
and `stateAt` (the server timestamp that `position` was true at) and never sends a
pre-extrapolated position — clients do that maths themselves, so a heartbeat can never
push the room forward on its own.

Each client measures its clock offset against the server using the round trip with the
lowest latency out of five samples, and re-measures every 60 seconds. A loop running
four times a second compares the local player position to the projected room position:

- **< 0.35 s** — leave it alone
- **0.35 s – 2 s** — nudge playback rate by ±6 % to glide back into place
  (players that support arbitrary rates: HTML5 video, Vimeo)
- **> 2 s** — seek

YouTube and Twitch only accept fixed playback rates, so they skip the nudging step and
use a tighter 1.2 s seek threshold instead. Live Twitch streams are exempt entirely —
there is no meaningful timestamp to sync to.

When **wait for everyone** is on, any client stalled for more than 900 ms tells the
server, which pauses the room and flags it as auto-paused. Once everybody reports
ready, it resumes on its own.
</details>

---

## 💾 Backup

Everything lives in one directory:

```
/data
├── 🗄️  wwf.db          accounts, rooms, queues, playlists, chat
├── 📝  wwf.db-wal
├── 🔑  session.key     generated if SESSION_SECRET is unset
└── 📁  uploads/        uploaded video files
```

A ZFS snapshot of the dataset is a complete backup. To restore: stop the container,
replace the directory, start it again.

---

## 📋 Known limits

- 🟣 Live Twitch syncs to the live edge — everyone sees roughly the same moment, but
  there's no shared scrub bar.
- ▶️ YouTube only accepts fixed playback rates, so drift is corrected by seeking. In
  practice that's an occasional small jump rather than continuous micro-adjustment.
- 🚫 Videos whose uploader disabled embedding can't play. The player says so and you
  can skip to the next item.
- 🔒 No DRM, so paid streaming services are out.

---

<div align="center">
<sub>Built for movie nights that actually start on time. 🎬</sub>
</div>
