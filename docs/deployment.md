# Deployment and configuration

CrowdQuest Live has two supported modes. `npm run dev` runs the existing local Node server with its in-memory challenge engine and local Twitch EventSub WebSocket adapter. The deployed Vercel build uses Convex as the persistent challenge source of truth, Convex reactive queries for the control room and overlay, Vercel HTTP functions for OAuth and authenticated streamer actions, and a Twitch EventSub webhook at the Convex HTTP Action URL. These paths share the deterministic challenge engine and command parser. They are separate execution modes, not competing production event pipelines.

The application-state WebSocket and outbound Twitch WebSocket remain useful for the local server only. The deployed route does not depend on a Node process staying alive. Twitch webhook deliveries are HMAC-verified, age-checked, deduplicated by both notification and chat message IDs, and applied in a Convex mutation. The Convex transaction serializes competing updates. The control room uses a sanitized state query; the overlay has a narrower query that omits suggestions, activity, viewer names, broadcaster/chat-reader IDs, credentials, and per-voter identity data.

The read-only production chat subscription uses an App Access Token and two user authorizations: the broadcaster grants `channel:bot`; a separate chat-reader account grants `user:read:chat` and `user:bot`. It does not request chat-write or moderation privileges. Connect the broadcaster first, then use **Connect chat reader** in the control room. The chat-reader account must differ from the broadcaster. The local WebSocket mode continues to use its existing `user:read:chat` scope. Twitch app-token, subscription, and permission rules are described in [Twitch chat authentication](https://dev.twitch.tv/docs/chat/authenticating) and [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types).

## Environment variable matrix

`.env.example` is a tracked template. `.env.local` is gitignored, loaded by the local Node `dev` script, and also read by Vite for `VITE_` values. Do not put credentials in `VITE_` variables. Vercel and Convex have separate runtime environments; setting a value in Vercel does not set it in Convex.

| Variable | Use | Public or secret | Where it belongs | Supply method | Required for |
|---|---|---|---|---|---|
| `NODE_ENV` | Runtime mode for secure cookies and blocking local demo routes in production | Non-secret | Runtime supplies it; do not put it in `.env.local` | Platform-generated (`production` on Vercel; development for local Node) | Both |
| `PORT` | Local Node HTTP listen port | Non-secret | `.env.local` | You may set it; default is 3000 | Local only |
| `HOST` | Local Node bind address | Non-secret | `.env.local` | You may set it; default is loopback | Local only |
| `DATA_DIR` | Local encrypted-token storage directory | Local path | `.env.local` | You may set it; default is `.data` | Local Twitch mode only |
| `TWITCH_CLIENT_ID` | Twitch app identity for OAuth and Helix calls | Public identifier | `.env.local`; Vercel Project Settings (runtime) | You supply it from Twitch Developer Console | Local Twitch and production |
| `TWITCH_CLIENT_SECRET` | Exchange/refresh OAuth tokens and mint App Access Tokens | Secret | `.env.local`; Vercel Project Settings (runtime) | You supply it from Twitch Developer Console | Local Twitch and production |
| `TWITCH_REDIRECT_URI` | Broadcaster OAuth callback; local Node uses `/auth/twitch/callback`, Vercel uses `/api/twitch/callback` | Public URL | `.env.local`; Vercel Project Settings (runtime) | You supply exact registered URL per environment | Local Twitch and production |
| `TWITCH_BOT_REDIRECT_URI` | Separate chat-reader OAuth callback | Public URL | `.env.local` when using `vercel dev`; Vercel Project Settings (runtime) | You supply exact registered URL | Production; optional local Vercel testing |
| `SESSION_SECRET` | Signs OAuth state and the HttpOnly streamer session cookie | Secret | `.env.local`; Vercel Project Settings (runtime) | You generate a random value of at least 32 bytes | Local Twitch and production |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM encryption key for Twitch tokens stored in Convex | Secret | `.env.local`; Vercel Project Settings (runtime) | You generate a base64-encoded 32-byte key | Local Twitch and production |
| `TWITCH_EVENTSUB_SECRET` | EventSub webhook HMAC secret; must match in sender/subscription setup and webhook verifier | Secret | Vercel Project Settings (runtime); Convex deployment environment | You generate a random value 10–100 characters and set the same value in both places | Production |
| `CONVEX_SERVICE_SECRET` | Authenticates Vercel server requests to internal Convex HTTP routes | Secret | Vercel Project Settings (runtime); Convex deployment environment | You generate a random value of at least 32 characters and set the same value in both places | Production |
| `CONVEX_URL` | Server-side Convex client URL (`.convex.cloud`) | Public URL | Vercel Project Settings (runtime) | Copy from the Convex deployment dashboard/CLI | Production |
| `CONVEX_SITE_URL` | Server-to-server Convex HTTP Action base URL (`.convex.site`) | Public URL | Vercel Project Settings (runtime) | Copy from the Convex deployment dashboard/CLI | Production |
| `VITE_CONVEX_URL` | Browser Convex reactive query/subscription URL | Public URL | Vercel build environment; `.env.local` only for local Vite use | Convex deploy build command injects it with `--cmd-url-env-var-name`; do not add a secret here | Production Vercel build; optional local frontend |
| `CONVEX_DEPLOYMENT` | Selects the local Convex development deployment | Non-secret deployment identifier | `.env.local` | Convex CLI creates/updates it when `npx convex dev` is configured | Local Convex development |
| `CONVEX_DEPLOY_KEY` | Authenticates `convex deploy` during Vercel builds | Secret | Vercel Project Settings (build/deployment environment) | Generate/copy a deploy key from Convex | Production Vercel deployment |
| `SIMULATED_CHAT_ENABLED` | Enables the local-only demo controls on loopback | Non-secret flag | `.env.local` | You set `true` for offline UI testing; default `false` | Local only |

## Local setup

1. Copy `.env.example` to `.env.local` (the repository includes a blank local template already).
2. Run `npm install` and `npm run dev`. This starts the local Node/WebSocket development mode and remains usable without Twitch credentials.
3. Set `SIMULATED_CHAT_ENABLED=true` in `.env.local` for the clearly labelled local demo controls.
4. The local server reads `.env.local` through Node's `--env-file-if-exists` option. Vite separately loads public `VITE_` variables. Convex function secrets are not loaded from `.env.local`; set them with `npx convex env set NAME VALUE` for the selected Convex deployment.

The local Node mode intentionally uses in-memory challenge state and the existing EventSub WebSocket adapter. Do not set `VITE_CONVEX_URL` in this mode unless the API routes are served by Vercel (`vercel dev`); otherwise the UI will subscribe to Convex while the local Node server does not provide the Vercel `/api` endpoints. For `vercel dev`, set the broadcaster redirect to `http://localhost:3000/api/twitch/callback` and the chat-reader redirect to `http://localhost:3000/api/twitch/bot/callback`, and register those exact URLs in the Twitch app.

## Twitch Developer Console setup

1. Create a Twitch application and set its OAuth Redirect URLs to the exact local and production callback URLs: `http://localhost:3000/auth/twitch/callback`, `https://YOUR_DOMAIN/api/twitch/callback`, and `https://YOUR_DOMAIN/api/twitch/bot/callback`.
2. Put the Client ID and Client Secret in local `.env.local` and Vercel runtime settings. Never place the client secret in a `VITE_` variable.
3. Generate `SESSION_SECRET` (at least 32 random bytes) and `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64 encoded) separately for each environment.
4. For production, configure the Convex/Vercel values below before authorizing accounts. The broadcaster signs in first. Then a separate chat-reader account signs in from the control room.
5. Twitch verifies the webhook callback when the subscription is created. The webhook endpoint must be reachable over HTTPS on port 443. Do not treat the UI's connected state as verified until Twitch completes callback verification and a real chat notification arrives.

The production chat subscription uses the documented App Access Token webhook authorization requirements, not the local installed-chatbot WebSocket flow. It requests no chat-write permission. See [Twitch chat authentication](https://dev.twitch.tv/docs/chat/authenticating), [webhook handling](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/), and [subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types).

## Convex and Vercel setup when ready to deploy

No external deployment or account setup has been performed. After creating your Convex project and Vercel project:

1. Run `npx convex dev` locally and select/create the development deployment. The CLI writes `CONVEX_DEPLOYMENT` to local configuration and generates the typed bindings. Run `npm run convex:codegen` after schema/function changes.
2. Set `CONVEX_SERVICE_SECRET` and `TWITCH_EVENTSUB_SECRET` in the selected development deployment (`npx convex env set --deployment dev NAME`, omitting the value to enter it interactively). After creating the production deployment, set both there too with `npx convex env set --prod NAME`. Each value must match the corresponding Vercel runtime variable. Convex validates the declared required variables when deploying functions.
3. In Vercel, import the repository and use the checked-in `vercel.json`. Add runtime variables from the matrix, including the Convex cloud/site URLs. Add `CONVEX_DEPLOY_KEY` as a protected build/deployment secret. Use separate preview and production deploy keys/deployments where appropriate.
4. The Vercel build command runs `npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'npm run build'`. Convex deploys functions/schema first, injects the public Convex URL into that build, then Vite builds the frontend into `dist/client`. The `/overlay` rewrite serves the same read-only SPA entry point. Vercel API functions have a 60-second limit to allow the OAuth exchange, token validation, and webhook subscription steps to finish within the platform's configured duration.
5. Register the public HTTPS callbacks in Twitch Developer Console. Set `TWITCH_REDIRECT_URI=https://YOUR_DOMAIN/api/twitch/callback` and `TWITCH_BOT_REDIRECT_URI=https://YOUR_DOMAIN/api/twitch/bot/callback` in Vercel. Set the webhook callback to `CONVEX_SITE_URL/twitch/eventsub` through the subscription flow; do not configure a separate Vercel webhook route.
6. Open the deployed control room, connect the broadcaster, then connect the separate chat reader. Check that EventSub callback verification succeeds, then send a real test command from another Twitch account. Only then is Live Twitch activity verified.

The deploy-command pattern and URL injection follow [Convex's Vercel hosting guide](https://docs.convex.dev/production/hosting/vercel); the public webhook endpoint uses [Convex HTTP Actions](https://docs.convex.dev/functions/http-actions). Convex environment variables are separate from Vercel variables; see [Convex environment variables](https://docs.convex.dev/production/environment-variables). Convex code generation needs a configured deployment, so it has not been run in this credential-free workspace.

## Security boundaries and pending checks

- Vercel mutations verify the signed HttpOnly session, revalidate the Twitch broadcaster token, enforce same-origin requests, and derive broadcaster ID from that session. The browser cannot supply a role or broadcaster authorization.
- Convex's public state query is sanitized. Mutations and credential queries are internal and the Convex HTTP bridge requires `CONVEX_SERVICE_SECRET`.
- The overlay subscribes to the same sanitized Convex query and has no control endpoint. It receives no session cookie, token, or internal secret.
- Webhook validation checks the original raw body, HMAC signature, message timestamp, and notification/chat-message deduplication. Challenge timers use Convex scheduled mutations and server time.
- No real Twitch credentials were provided; live OAuth, webhook callback verification, real chat, Vercel deployment, and Convex cloud persistence remain unverified manual checks.
