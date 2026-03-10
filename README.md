# GH PR Watcher

Tray-based Electron app that watches GitHub Pull Requests (via `gh` CLI) for specific authors in a single org.

## Features

- macOS/Windows/Linux via Electron
- Manual config:
  - single org
  - author usernames list
  - polling interval (minutes)
- `Check now` button
- Detects **new PRs** and **updates**
- Native notifications (click opens PR in browser)
- In-app Notification Center with per-PR snooze:
  - Snooze 1 hour
  - Snooze till tomorrow (9:00 AM local)
- Remembers seen PRs and snoozes across restarts
- Uses `gh` auth (no embedded OAuth)

## Requirements

- Node 18+
- GitHub CLI (`gh`) installed and authenticated

```bash
gh auth login
gh auth status
```

## Run

```bash
npm install
npm start
```

## Build

```bash
npm run dist
```

Artifacts will be in `dist/`.

## macOS note (unsigned builds)

Current releases are not code-signed/notarized yet, so Gatekeeper may block first launch.

If macOS says the app is damaged, remove quarantine and open again:

```bash
xattr -dr com.apple.quarantine "/Applications/GH PR Watcher.app"
```

(or run it against the app inside the mounted DMG/unzipped folder before moving it).

## Notes

PR query uses:

```bash
gh search prs "org:<ORG> author:<USER>" --limit 100 --json number,title,url,updatedAt,state,repository,author,isDraft
```

If auth is missing, app shows: `Run: gh auth login`.
