# Scrollantir — Admin CLI spec

Local-only Python tool at `scripts/admin.py`. Manages devices, mints
and rotates bearer tokens, assigns passwords to custom Postgres
roles. Uses `service_role` credentials; never touches the wire auth
path.

Not yet implemented. This doc is the spec.

## File layout

```
scripts/
├── admin.py              # the CLI entry point
├── admin/                # implementation package
│   ├── __init__.py
│   ├── db.py             # psycopg connection, service_role
│   ├── devices.py        # device add/list/rename/retire
│   ├── tokens.py         # mint/list/revoke/rotate
│   ├── roles.py          # setup-roles (assigns passwords)
│   └── qr.py             # terminal QR rendering
└── .env.admin.example    # commit this; the real `.env.admin` stays local
```

## Dependencies

```
# scripts/requirements.txt
psycopg[binary]>=3.2
keyring>=24
qrcode>=7.4
click>=8.1        # CLI framework; pick whatever feels right
```

Python 3.11+. Developer runs with a local venv:

```
python3 -m venv scripts/.venv
source scripts/.venv/bin/activate
pip install -r scripts/requirements.txt
```

## Configuration

Reads `DATABASE_URL` in this order:

1. `$SCROLLANTIR_ADMIN_DATABASE_URL` env var
2. `scripts/.env.admin` (gitignored; format `DATABASE_URL=postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres`)

Error if missing. Never logs the URL or password.

Get the service_role connection string from Supabase dashboard:
*Settings → Database → Connection string → `psql`*.

## Commands

### `device add <device_id> --label "<label>" --platform <p> [--note <n>]`

Insert one row into `public.devices`. `<device_id>` is the stable identifier that events will carry (`mac`, `phone`, `phone-backup`, …). Platform must be one of `macos`, `android`, `ios`, `linux`.

Fails if `device_id` already exists.

### `device list`

Table output:

```
DEVICE_ID        LABEL             PLATFORM  CREATED              RETIRED              NOTE
mac              MacBook Pro 16    macos     2026-04-20 11:32     —                    primary dev
phone            Pixel 9           android   2026-04-20 11:35     —
desktop-mini     Mac Mini M4       macos     2026-04-20 14:10     —                    test machine
```

### `device rename <device_id> --label "<new>"`

Updates `devices.label`. No auth impact (label is mutable; `device_id` is immutable).

### `device retire <device_id>`

Sets `retired_at = NOW()`. `ingest_api.accept_event` rejects events for retired devices with SQLSTATE `28000`. Historical events are preserved.

### `setup-roles`

One-time (or occasional rotation) operation. For each of `ingest_role`, `user_role`, `agent_role`:

1. Generates a 32-byte random password (use `secrets.token_urlsafe(32)`).
2. `ALTER ROLE <role> WITH LOGIN PASSWORD '<random>'`.
3. Builds connection string: `postgresql://<role>:<password>@<host>:5432/postgres`.
4. Stores in:
   - Mac Keychain under `scrollantir / <role>` (via `keyring.set_password`)
   - AND prints to stdout with clear "copy this into the edge function secret" instructions for `ingest_role`.

Uses `keyring.set_password("scrollantir", "ingest-role", "<connection string>")` etc.

Prints at end:

```
✓ user_role    → keychain: scrollantir/user-role
✓ agent_role   → keychain: scrollantir/agent-role
✓ ingest_role  → keychain: scrollantir/ingest-role

Next: set the ingest_role URL as a Supabase function secret:
  supabase secrets set INGEST_DATABASE_URL='<paste the full URL>'
```

Safe to re-run (rotates passwords). Old sessions get evicted; clients need to re-read Keychain.

### `mint --device-id <id> [--note <n>] [--show-token]`

Mints a new bearer token.

1. Generate 32 bytes → `secrets.token_urlsafe(32)` → ~43-char plaintext
2. Compute `sha256(plaintext).hexdigest()` for `token_hash`
3. Take first 8 chars of plaintext for `token_prefix`
4. `INSERT INTO private.tokens (token_hash, token_prefix, device_id, note) VALUES (...)`
5. Build QR payload:
   ```json
   {
     "v": 2,
     "url": "https://<project-ref>.supabase.co/functions/v1/ingest",
     "token": "<plaintext>",
     "device_id": "<id>",
     "label": "<looked up from devices>",
     "platform": "<looked up from devices>"
   }
   ```
6. Render QR in the terminal (`qrcode.QRCode(...)`, print ASCII).
7. If `--show-token`, also print plaintext. Else print prefix only.

Output:

```
Minted token for device 'mac' (MacBook Pro 16).

┌────────────────────────────────────────────┐
│  QR code here (scan on phone to onboard)   │
└────────────────────────────────────────────┘

Prefix: a3f891e2

For Mac: re-run mac-forwarder/setup.sh and paste the URL + token when prompted.
For phone: scan the QR above from the Android app's "Scan Onboarding QR" button.

URL: https://feijpewzqgqczkxmvdng.supabase.co/functions/v1/ingest
```

### `list`

Token listing, showing all historic tokens (active, superseded, revoked):

```
DEVICE_ID        PREFIX    CREATED              LAST_USED            STATE        NOTE
mac              a3f891e2  2026-04-20 11:32     2026-04-20 11:34     active       primary
mac              k9Lq7tGx  2026-04-21 08:10     2026-04-21 08:45     active       rotated
mac              c291ee88  2026-03-01 09:00     2026-04-18 22:40     revoked      lost laptop
phone            4b7c2d9e  2026-04-20 11:35     2026-04-20 11:40     active
```

State derived:
- `revoked_at IS NOT NULL` → `revoked`
- `superseded_at IS NOT NULL` → `superseded` (still valid until 48h, then auto-revoked via cron)
- else → `active`

### `revoke --prefix <8-char-prefix>`

`UPDATE private.tokens SET revoked_at = NOW() WHERE token_prefix = $1 AND revoked_at IS NULL`

Fails if prefix matches 0 or >1 rows.

### `revoke-all --device-id <id> --yes`

Revokes every non-revoked token for the device. Requires `--yes` flag to protect against footgun during rotation.

### `rotate --device-id <id>`

1. `UPDATE private.tokens SET superseded_at = NOW() WHERE device_id = $1 AND superseded_at IS NULL AND revoked_at IS NULL`
2. Invoke `mint --device-id <id> --show-token` internally

Old tokens remain valid for 48h (enforced in `accept_event`); new token works immediately. Prints:

```
Rotated tokens for 'mac'.
  Superseded: 1 token(s)
  New token:  prefix k9Lq7tGx

Old tokens auto-revoke in 48h, or use `./admin rotate --device-id mac --finalize` to immediate-revoke.
```

### `rotate --device-id <id> --finalize`

`UPDATE private.tokens SET revoked_at = NOW() WHERE device_id = $1 AND superseded_at IS NOT NULL AND revoked_at IS NULL`.

Explicit shortcut for "I've verified the new token is flowing; kill the old ones now."

## Pitfalls to avoid

- **Never log plaintext tokens.** `mint` prints them exactly once. Don't put `ingest_role`'s password in any committed file.
- **`scripts/.env.admin` must be gitignored.** Add to `.gitignore` if not already there.
- **Keychain entry names must be exactly `scrollantir / user-role`, `scrollantir / agent-role`, `scrollantir / ingest-role`.** The Swift app and Mac forwarder read by these exact names.
- **Psycopg binary wheels:** use `psycopg[binary]`, not plain `psycopg`, unless you want to wrestle with `libpq` installation.
- **Connection string has special characters.** Always URL-encode the password. `secrets.token_urlsafe` produces URL-safe chars, so `@`, `/`, `:`, `?`, `#` won't appear; safe to format inline.
- **`ALTER ROLE ... PASSWORD 'x'` is audit-logged in Postgres.** That's fine (service_role connection) but be aware.

## Acceptance

Run in order:

```bash
./admin device add mac --label "MacBook Pro" --platform macos
./admin device add phone --label "Pixel 9" --platform android

./admin setup-roles    # first time; sets up ingest/user/agent role passwords

./admin mint --device-id mac --show-token
# paste into mac-forwarder/setup.sh

./admin mint --device-id phone
# scan QR with phone

./admin list
# both tokens visible, both active

./admin rotate --device-id mac
./admin list
# two mac tokens, one active, one superseded

./admin rotate --device-id mac --finalize
./admin list
# one mac token active, one revoked
```

## Related

- `docs/supabase.md` — trust boundaries, the `private.tokens` schema
- `docs/edge-functions.md` — how `ingest_role` is used on the server side
- `docs/roadmap.md` — this CLI is #1 in the implementation sequence
