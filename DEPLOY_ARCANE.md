# Deploying with Arcane

On every push to `main`, GitHub Actions builds `ghcr.io/robich20/lessonai:latest`.
Arcane connects the repository as a Git project, reads `compose.yaml` and pulls the prebuilt image.
Data lives in `./data` next to `compose.yaml`; secrets only in the `.env` kept in Arcane.

Menu names may differ slightly between Arcane versions.

## 1. Project

1. If the image is private: **Settings → Container Registries** → `ghcr.io`, your GitHub login and a token with `read:packages`.
2. **Projects → New project** from a Git repository: branch `main`, compose file `compose.yaml`.
3. **Configuration → `.env`**: paste [`.env.arcane.example`](.env.arcane.example) and fill in
   `APP_URL`, `APP_PASSWORD`, `SECRET_KEY` (`openssl rand -hex 32`), `OPENROUTER_API_KEY`, `HOST_PORT`.
4. **Save → Redeploy**. Once the container is healthy, `http://server:HOST_PORT` shows the login page.

## 2. HTTPS

iPhone only allows the microphone on `https://`. The simplest option is Cloudflare Tunnel:

- a separate tunnel: Public hostname → `http://localhost:HOST_PORT`;
- or uncomment `cloudflared` in `compose.yaml`, add `TUNNEL_TOKEN` to `.env`, service `http://lessonai:8000`.

Then put the https address into `APP_URL` and redeploy.

## 3. Data

```
data/
  lessonai.db      subjects, lessons, notes, homework, chat
  lessons/<id>/    lesson audio
```

Redeploy and Sync from Git don't touch this folder. Backup: copy `data`. Moving from another install:
stop both, copy the old `data` contents into the new one, start.

## 4. Auto-update

`compose.yaml` has the label `com.getarcaneapp.arcane.updater: "true"`. In Arcane, under **Settings → Jobs / Schedules**,
enable image update checks (e.g. every 15 min) and **Auto Update**. Then a push → Actions builds `:latest` →
Arcane restarts the container.

Manually: wait for Actions to go green and press **Redeploy** (`pull_policy: always`).
If `compose.yaml` itself changed, run **Sync from Git** first.

## Troubleshooting

- container won't start: check **Logs**, usually an incomplete `.env`;
- `unauthorized` on pull: check the ghcr.io registry and token;
- microphone doesn't work on iPhone: the site isn't opened over `https://`.
