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
![License](https://img.shields.io/badge/license-private-lightgrey?style=flat-square)

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

> [!IMPORTANT]
> This repository is **private**, so every command below needs credentials.
> Set that up once on your server first — see
> [🔑 Authenticating a private repo](#-authenticating-a-private-repo).

### Option A — one command on your server ⚡

```bash
gh repo clone bejak1999/watch-with-friends && cd watch-with-friends && ./install.sh
```

The script checks Docker, generates your `SESSION_SECRET`, asks for your domain and
admin password, writes `.env`, builds the image, and starts everything. Takes about
two minutes. Re-run it any time after `git pull` to update — it detects the existing
`.env` and leaves your data alone.

### Option B — pull a prebuilt image 🐳

Every push to `main` builds an image and publishes it to GitHub Container Registry,
so your server never has to compile anything. Good for a NAS with a slow CPU.

```bash
# 1. Log in to the registry (token needs read:packages)
echo <YOUR_TOKEN> | docker login ghcr.io -u bejak1999 --password-stdin

# 2. Grab the two files you need. raw.githubusercontent.com does not work on a
#    private repo, so fetch them through the API or just clone the repo.
gh api repos/bejak1999/watch-with-friends/contents/docker-compose.ghcr.yml \
  --jq '.content' | base64 -d > docker-compose.ghcr.yml
gh api repos/bejak1999/watch-with-friends/contents/.env.example \
  --jq '.content' | base64 -d > .env

# 3. Edit .env - at minimum set SESSION_SECRET
nano .env

docker compose -f docker-compose.ghcr.yml up -d
```

Updating later:
```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

### Option C — plain Docker Compose 🔧

```bash
cp .env.example .env
# set SESSION_SECRET:  openssl rand -base64 48
docker compose up -d --build
```

### 🔑 Authenticating a private repo

Pick whichever suits your server:

<details>
<summary><b>GitHub CLI</b> — easiest, works for both git and GHCR</summary>

```bash
# Install: https://github.com/cli/cli#installation
gh auth login            # device flow, no password typing
gh auth setup-git        # lets plain `git clone/pull` work too

# And for pulling container images:
gh auth token | docker login ghcr.io -u bejak1999 --password-stdin
```
</details>

<details>
<summary><b>Personal access token</b> — good for headless boxes</summary>

Create a **classic** token at <https://github.com/settings/tokens> with the `repo` and
`read:packages` scopes, then:

```bash
git clone https://<TOKEN>@github.com/bejak1999/watch-with-friends.git
echo <TOKEN> | docker login ghcr.io -u bejak1999 --password-stdin
```

Store it in `~/.git-credentials` (via `git config --global credential.helper store`)
so `git pull` keeps working unattended.
</details>

<details>
<summary><b>Deploy key</b> — read-only, scoped to this one repo</summary>

```bash
ssh-keygen -t ed25519 -C "truenas-wwf" -f ~/.ssh/wwf_deploy
cat ~/.ssh/wwf_deploy.pub
```

Paste the public key under **Settings → Deploy keys → Add deploy key** in this repo,
then:

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/wwf_deploy" \
  git clone git@github.com:bejak1999/watch-with-friends.git
```

Note that a deploy key covers `git` only — GHCR image pulls still need a token.
</details>

### 🔓 First sign-in

If you left `ADMIN_PASSWORD` empty, the password is printed once in the log:

```bash
docker compose logs watch-with-friends | grep -A3 "FIRST RUN"
```

Open `http://<server-ip>:8080`, sign in, and **change that password** under Settings.

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
   - **Image**: `ghcr.io/bejak1999/watch-with-friends:latest` (add your GHCR
     credentials under *Image pull secrets*), or a locally built `watch-with-friends`
   - **Port**: container `8080` → node port, e.g. `30080`
   - **Storage**: host path `/mnt/tank/apps/wwf` → mount path `/data`
   - **Environment**:

     | Name | Value |
     |---|---|
     | `SESSION_SECRET` | a long random string |
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

## ⚙️ Environment variables

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
