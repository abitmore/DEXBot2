# Docker Build and Shipping

DEXBot2 now ships container images only for release tags matching `v*.*.*`.

## Published image tags

- `latest` - most recent stable release build (not updated for pre-release tags)
- `vX.Y.Z` - release tag image
- `sha-<commit>` - immutable commit build

Images are published to:

`ghcr.io/froooze/dexbot2`

## Local build

```bash
docker build -t dexbot2:local .
docker run --rm -it dexbot2:local node dexbot.js help
```

## Secure startup (single prompt, no PM2)

For production and best secret hygiene without PM2, use the bundled unlock launcher:

```bash
node unlock-start.js
```

- Enter the master password once interactively.
- Password stays in daemon memory (RAM) and is not stored in `.env`.
- Bot processes request private keys through the daemon socket.

To start only one bot:

```bash
node unlock-start.js <bot-name>
```

## Run with Docker Compose

1. Create a `.env` file in the project root:

```dotenv
BOT_NAME=my-bot
RUN_LOOP_MS=5000
```

2. Start the bot:

```bash
docker compose up
```

This compose mode runs `dexbot.js` directly and may prompt for the master password.

3. View logs:

```bash
docker compose logs -f dexbot
```

4. Stop:

```bash
docker compose down
```

## Notes

- Persist bot state/config by mounting `./profiles:/app/profiles`.
- Keep `.env` for non-sensitive runtime values (for example `BOT_NAME`, `RUN_LOOP_MS`).
- Do not store `MASTER_PASSWORD` in `.env` when using the credential-daemon security model.
- If you prefer immutable pinning, replace `latest` in `docker-compose.yml` with a `sha-<commit>` tag.
