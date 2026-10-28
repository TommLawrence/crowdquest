# CrowdQuest Live

CrowdQuest Live turns Twitch chat into a collaborative challenge. It includes a server-authoritative challenge engine, a streamer control room, a read-only OBS overlay, local demo controls, and Twitch chat integration.

## Run locally

Requirements: Node.js 24+ and npm.

```sh
npm install
npm run dev
```

Open `http://localhost:3000`. The local Node server and its in-memory engine run without credentials. To enable offline demo controls, set `SIMULATED_CHAT_ENABLED=true` in `.env.local` and restart the server. Demo events are generated locally and never represent Twitch chat. The local EventSub WebSocket mode is for development; deployed state and chat processing use Convex and Twitch EventSub webhooks.

Open `/overlay` as an OBS Browser Source. It is read-only and transparent over gameplay.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

## Deployment and Twitch setup

The production architecture, environment-variable matrix, Twitch Developer Console setup, and Convex/Vercel deployment steps are in [docs/deployment.md](docs/deployment.md). Copy the blank `.env.local` template as needed; keep real credentials out of source control. `.env.example` contains placeholders only.

The production chat reader uses Twitch EventSub webhooks with a separate chat-reader account. It does not request chat-write or moderation scopes. Real OAuth, chat delivery, Convex cloud persistence, and deployment have not been verified without credentials.
