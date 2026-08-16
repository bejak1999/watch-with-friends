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
| 🧩 | **Survives SponsorBlock.** When an extension skips ahead, the room follows instead of fighting it — one person's skip skips it for everyone. An ad that freezes one player makes the room wait. |
| 💾 | **One-file backup.** Download everything — accounts, rooms, statistics, pictures — and upload it back to restore. Optionally encrypted with a password. |
| 📊 | **Statistics.** Watch time, videos played, per-room leaderboards and a two-week activity chart, counted on the server so nobody can inflate them. |
| 🖼️ | **Profile pictures.** Upload an avatar, cropped and resized in your browser. Admins can fix somebody else's. |
| 🔍 | **Resolution control.** Pick a rendition for HLS, ARD, Vimeo and Twitch — your choice only, so a slow connection never drags anyone else down. |
| 📱 | **Works on phones.** Responsive layout, fullscreen, keyboard shortcuts, and controls that adapt instead of clipping. |

## 📺 Supported sources

| Source | Support |
|---|---|
| ▶️ **YouTube** | Videos, Shorts, and full playlist import |
| 📺 **ARD Mediathek** | Also fronts BR, WDR, NDR, MDR, SWR, hr and rbb |
| 📺 **ZDF · 3sat** | ZDF, ZDFneo, ZDFinfo and 3sat share one API |
| 🎭 **arte** | Every language arte publishes in |
| 🇨🇭 **SRF · RTS · RSI · RTR** | Swiss public broadcasting |
| 🔵 **Vimeo** | Public and embeddable videos |
| 🟣 **Twitch** | VODs sync normally · live channels sync to the live edge |
| 🅳 **Dailymotion** | Through the embed player |
| 🐙 **PeerTube** | Any instance in the network |
| 🏛 **Internet Archive** | Public-domain films and recordings |
| 🔗 **Direct links** | `.mp4` · `.webm` · `.mkv` · `.m3u8` (HLS) · audio files |
| 📤 **Uploads** | Streamed from your own server, with admin-set storage quotas |

**Search once, find everything.** The Search tab has a *Mediatheken* mode backed by
MediathekViewWeb, which indexes ARD, ZDF, 3sat, arte, ORF, SRF, DW and every regional
channel at the same time — no API key needed. YouTube search needs a key; the
Mediathek search does not.

Adding another site is one file under `server/src/services/providers/`: match a URL,
return metadata, optionally resolve a fresh stream at play time.

> [!NOTE]
> **No DRM support** — Netflix, Disney+ and friends will not work. That's a browser
> restriction, not something any self-hosted app can get around. A handful of
> public-broadcaster programmes are DRM protected too; those report a clear error
> rather than failing silently.
>
> **Geo-blocking still applies.** Streams are fetched by the viewer's browser, not
> by your server, so an ARD or SRF programme restricted to its country only plays
> for people in that country.
>
> Sites deliberately left out: ORF (its API now requires authentication), Reddit
> (blocks server-side requests), and TikTok/Instagram/X, whose private endpoints
> change constantly and would break every few weeks.

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

# Clear one account's failed-login back-off
docker exec -it watch-with-friends node server/dist/admin-cli.js unlock admin

# Clear EVERY counter, including the address lockout your own retries created
docker exec -it watch-with-friends node server/dist/admin-cli.js unlock --all

# Add a brand-new admin account
docker exec -it watch-with-friends node server/dist/admin-cli.js create benni 'my new password'
```

Common causes:

| Symptom | Cause | Fix |
|---|---|---|
| "Wrong username or password" right after setting `ADMIN_*` | Those only apply to an empty database | `admin-cli.js reset` |
| Forgot the generated password | It was printed once, on first start | `admin-cli.js reset` |
| "Too many failed attempts" | Brute-force back-off | Wait it out, or `admin-cli.js unlock --all` — retrying locks your *address* as well as the account, so unlocking just the account is not enough |
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
whenever the request arrives over HTTPS. Every session carries a version number, so
**changing a password or disabling an account signs out every device instantly** —
a cookie stolen earlier stops working the moment the password changes.

**No server-side request forgery.** Resolving a pasted link is the one place a member
can make the server talk to another host, so it refuses to probe anything that
resolves to a private, loopback, link-local or reserved address — your router, other
NAS services and cloud metadata endpoints are all out of reach. Playing a LAN file
still works (`http://192.168.1.50:8096/movie.mp4`), because playback happens in your
own browser and never touches the server.

**Everything a browser sends is validated**, over REST *and* WebSocket: queue items
must name a known source and an `http(s)` or upload URL, so nobody can inject a
`javascript:` or `file:` link into someone else's player. Chat and queue edits are
rate-limited per connection.

**Response headers**: `nosniff`, `X-Frame-Options: SAMEORIGIN` (the admin panel can't
be framed), a strict referrer policy, and `Permissions-Policy` denying camera,
microphone and geolocation.

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
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

---

## ⌨️ Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | ⏯️ Play or pause |
| `←` `→` | ⏪ Skip 5 seconds |
| `Shift` + `←` `→` | ⏩ Skip 30 seconds |
| `N` | ⏭️ Next in queue |
| `M` | 🔇 Mute |
| `C` | 💬 Subtitles on or off |
| `B` | ↔️ Hide or show the side panel |
| `D` | 🐞 Diagnostics overlay |
| `F` | 🖥️ Fullscreen |
| `T` | 🎦 Theater mode |

---

## 🐞 When something goes wrong

No guessing games. There are three places to look, in order:

**1. The diagnostics overlay** — press `D` in a room, or click the 🐞 button in the
control bar. It shows, live:

| | |
|---|---|
| Connection | connected or dropped |
| Clock offset | how far your clock is from the server's |
| Room says | what the server thinks is playing, and where |
| This player | what your player is actually doing |
| Drift | the gap between the two, and whether it is being corrected |
| Waiting for buffer | who the room is waiting on |
| Source, Room, Online | which provider, which room, how many people |

**Copy** puts the whole table on your clipboard — paste it straight into a bug report.

**2. The server log** — Admin → **Logs**. The last 500 events, live-updating, filterable
by level and by area (`http`, `auth`, `sync`, `media`, `admin`, `boot`). **Download** saves
it as a text file with the Node version, uptime and memory alongside. Passwords, tokens
and cookies are redacted before anything is recorded.

**3. Turn the detail up** — set `LOG_LEVEL=debug` and restart. Every API request, every
media resolution and every buffering change gets printed to the container log too. The
in-app viewer always keeps debug lines regardless of this setting, so you usually do not
need it.

Common things the log will tell you outright:

| Symptom | Look for |
|---|---|
| Playback keeps pausing | `sync` → `waiting for buffer` — it names who |
| A link will not add | `media` → `provider failed` — with the site's own error |
| Someone cannot sign in | `auth` → `login failed` or `login blocked by back-off` |
| The room froze | `sync` → `gave up on stuck viewers` after 25s |
| Random disconnects | `sync` → `disconnected` with the reason |

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

### From the admin panel

**Admin → Backup → Download backup** produces a single `.wwfbak` file holding every
account, room, queue, playlist, chat message, statistic and profile picture, plus the
session key so nobody is signed out by a restore. Uploaded video files are opt-in,
because they dominate the size.

Restoring is the same page in reverse: upload the file, it is **verified and unpacked
first**, and nothing is replaced until you restart the container. A corrupt file or a
wrong password therefore cannot break a running server. What it does replace is
renamed to `*.replaced-<timestamp>` rather than deleted, so a restore you regret is
still undoable by hand.

> [!IMPORTANT]
> Tick **Encrypt with a password** unless the file never leaves an encrypted disk.
> An unencrypted backup contains password hashes, your whole chat history and your
> YouTube API key in readable form. Encryption is AES-256-GCM with a scrypt-derived
> key; a lost password cannot be recovered, by design.

### From the filesystem

Everything still lives in one directory:

```
/data
├── 🗄️  wwf.db          accounts, rooms, queues, playlists, chat, statistics
├── 📝  wwf.db-wal
├── 🔑  session.key     generated if SESSION_SECRET is unset
├── 🖼️  avatars/        profile pictures
└── 📁  uploads/        uploaded video files
```

A ZFS snapshot of the dataset is a complete backup. To restore, stop the container,
replace the directory, start it again.

---

## 🔐 What is and is not encrypted

Worth being precise about, because "self-hosted" does not mean "encrypted".

| | |
|---|---|
| **Passwords** | Never stored. Only a scrypt hash with a per-user salt, which cannot be reversed. |
| **Sessions** | Signed JWTs in an `httpOnly` cookie. Signed, not encrypted — they carry only a user id and a version number. |
| **In transit** | HTTPS end-to-end when reached through your Cloudflare tunnel. |
| **Backup files** | Encrypted **if you set a password**. Otherwise plain. |
| **The database on disk** | **Not encrypted.** Chat, room names and your YouTube API key sit in a plain SQLite file. |
| **Uploads and avatars** | **Not encrypted.** Plain files in the data directory. |

That last pair is normal for a self-hosted app, and the right place to fix it is the
storage layer rather than the application: on TrueNAS, create the dataset with
**encryption enabled** (Datasets → Add Dataset → Encryption). Everything then lands on
an encrypted pool, the app needs no changes, and you keep the key.

Filesystem permissions are the other half: the container runs as uid 1000 and the data
directory should not be world-readable.

> [!NOTE]
> Application-level database encryption (SQLCipher) is deliberately not used. It would
> mean shipping a different SQLite build for a key that has to live on the same machine
> anyway — dataset encryption gives you the same protection against a stolen disk
> without that complexity.

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
