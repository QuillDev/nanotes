# Self-hosted Sync Server & MCP

`nanotes` includes a self-hosted Bun + SQLite sync server (`server/main.ts`) with WebAuthn passkey authentication, desktop device pairing, and a Streamable HTTP MCP endpoint (`/mcp`) so AI agents can read and write the exact same synced notes.

## Running the server

```bash
bun install
NANOTES_DATABASE=./nanotes.sqlite \
NANOTES_ORIGIN=https://notes.example.com \
NANOTES_MCP_TOKEN="$(openssl rand -hex 32)" \
bun run server
```

| Variable | Default | Description |
| --- | --- | --- |
| `NANOTES_DATABASE` | required | SQLite file path (created and migrated automatically) |
| `NANOTES_ORIGIN` | unset | Public `https://` origin; enables passkey sign-in (RP ID = hostname) |
| `NANOTES_PASSWORD_HASH` | unset | Optional Argon2 password fallback (`bun -e 'console.log(await Bun.password.hash("..."))'`) |
| `NANOTES_MCP_TOKEN` | unset | Bearer token for `/mcp`; MCP is disabled when unset |
| `NANOTES_HOST` / `NANOTES_PORT` | `127.0.0.1` / `8098` | Listen address |
| `NANOTES_SECURE_COOKIES` | `true` | Set `false` only for plain-HTTP local testing |

Put the server behind a TLS reverse proxy (such as Caddy) for anything beyond localhost.

## Adding your first passkey

Mint a one-time 24-hour registration link on the host:

```bash
NANOTES_DATABASE=./nanotes.sqlite \
NANOTES_ORIGIN=https://notes.example.com \
bun run server:setup-link
```

Open the printed URL in your browser and register your passkey. Additional passkeys can be added later from the web UI or the MCP `passkey_setup_link` tool.

## Connecting a desktop app

1. Open Settings (`Cmd+O` on macOS, `Ctrl+O` on Windows/Linux) and expand **Sync**.
2. Enter your sync server URL (e.g. `https://notes.example.com`) and click **Sign in**.
3. Approve the device in your browser with your passkey — `nanotes` receives a revocable per-device token and begins syncing automatically.

Notes stay local-first as plain `.md` files in your notes folder. Offline edits, renames, pins, and deletes sync cleanly across machines; if two machines edit the same note offline, `nanotes` preserves both versions with a conflict copy.

## Connecting an AI agent via MCP

Point any Streamable HTTP MCP client at `https://notes.example.com/mcp` with header `Authorization: Bearer <NANOTES_MCP_TOKEN>`.

Exposed tools: `list_notes`, `search_notes`, `read_note`, `create_note`, `update_note`, `append_note`, `delete_note`, and `passkey_setup_link`.
