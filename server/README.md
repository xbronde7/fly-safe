# Fly Safe entitlement server

Standalone TypeScript service for ISK invoices, cashier-wallet reconciliation, prepaid credits,
subscriptions, devices, signed offline entitlements, and character-authenticated Corp/Fleet shared
workspaces. It does not transfer ISK: EVE has no ESI endpoint for automatic wallet withdrawals. A
player sends ISK manually; this service detects the incoming journal entry and applies it once.

## Runtime

- Node.js 22.13+
- SQLite through `better-sqlite3` (WAL mode for file databases)
- EVE SSO JWT validation through discovery and remote JWKS
- Ed25519 compact entitlement tokens

```bash
cd server
npm ci
cp .env.example .env
# Provision the existing matching private key at ./secrets/entitlement-private.pem (mode 0600).
npm test
npm run build
node --env-file=.env dist/src/index.js
```

Never commit `.env`, the Ed25519 private key, the cashier refresh token, or the admin token.
Put HTTPS and request throttling in a reverse proxy. Back up the SQLite database and signing key
separately. File-backed SQLite storage is opened with a private `0700` parent and `0600`
database/WAL/SHM files; still run the process under a dedicated unprivileged OS account.

### Standalone zKillboard/R2Z2 relay

The relay can run without the billing database, cashier credentials, entitlement signing key, or
other billing configuration. Build its self-contained JavaScript entry point from the repository
root and start it with a descriptive upstream user agent:

```bash
npm run build:relay
ZKILL_RELAY_USER_AGENT='Fly-Safe/0.12.6 (standalone zKill relay; contact@example.com)' \
  node server/relay-dist/fly-safe-relay.mjs
```

`ZKILL_RELAY_USER_AGENT` is required. `HOST` and `PORT` default to `127.0.0.1` and `8787`;
`ZKILL_BASE_URL` and `R2Z2_BASE_URL` normally keep their public defaults. For local source-mode
development use `npm --prefix server run dev:relay`. A compiled server tree can instead be run
with `npm --prefix server run build` followed by `npm --prefix server run start:relay`.

Deployment templates are in `server/deploy/`:

- `fly-safe-relay.env.example` — runtime environment;
- `fly-safe-relay.service` — hardened systemd unit;
- `nginx-bootstrap.conf` — port 80 ACME bootstrap;
- `nginx-relay.conf` — TLS reverse proxy on port 8443 with limits;
- `reload-nginx-after-renew.sh` — Certbot deploy hook.

`nginx-relay.conf` uses the standard `limit_req` and `limit_conn` modules. On Ubuntu install
`nginx-core` (the smaller `nginx-light` build disables both modules).

Replace `__RELAY_DOMAIN__` and `__RELAY_PUBLIC_URL__` before installing the templates. The current
production endpoint is `https://fly-safe-relay.66.163.117.187.sslip.io:8443`; `/healthz` is public,
while every relay route still requires a valid Fly Safe EVE bearer.

The EVE application ID is intentionally fixed to Fly Safe:
`722024be688548e4b022064636ecd652`. `loadConfig` rejects another ID, preventing a desktop/server
audience mismatch. The ID is public; a client secret and refresh tokens are not.

The cashier refresh token needs `esi-wallet.read_character_wallet.v1`. Setting
`CASHIER_REFRESH_TOKEN_PATH` is recommended: a refresh token returned during rotation is persisted
atomically with mode `0600`. The environment value is the bootstrap fallback.

Official protocol references:

- [EVE SSO and PKCE/JWT validation](https://developers.eveonline.com/docs/services/sso/)
- [ESI overview and compatibility dates](https://developers.eveonline.com/docs/services/esi/overview/)
- [Current ESI OpenAPI document](https://esi.evetech.net/meta/openapi.json)

## Payment lifecycle

1. Desktop signs in through EVE SSO. License not required for sign-in, plans, invoice creation, or
   device registration.
2. `POST /v1/invoices` returns cashier character ID, exact ISK amount, and one `FS-XXXXXXXX` reason.
3. Player uses **Give Money** and copies that reason when the EVE transfer dialog exposes a reason
   field. The exact amount and paying character remain mandatory either way.
4. Poller reads the cashier character wallet. It honors `ETag`, `If-None-Match`,
   `Last-Modified`, `Expires`/`Cache-Control`, `Retry-After`, ESI error-limit headers, and pagination.
5. One SQLite transaction records payment, credits account, charges subscription purchase, extends
   `paidThrough`, and marks invoice paid.
6. Entitlements for active devices receive a new revision. Desktop periodically requests
   `/v1/entitlements/current` and stores the newer signed token.

A journal payment matches only when all rules pass:

- unique journal `id` was never processed;
- `ref_type` is `player_donation` and amount is positive;
- cashier is one party and authenticated invoice character is the other party;
- invoice receiver, payer, and amount match exactly;
- EVE transaction timestamp is inside the invoice window.

When ESI returns a non-empty `reason`, it must contain exactly one complete Fly Safe payment code;
that code is the preferred and strict match key. Some personal **Give ISK** journal entries arrive
with `reason:null`. Only in that case the server falls back to payer character + cashier + exact
amount + invoice window, and only when exactly one still-payable invoice matches. Zero candidates
are ignored; two or more are marked `ambiguous_invoice_without_reason` for manual review. A
non-empty wrong/missing/ambiguous code never falls back to amount matching.

An expired invoice can still be reconciled when EVE timestamp proves payment occurred before expiry.
A second wallet entry with the same reason does not reuse a paid invoice. Every ESI int64 ID remains
a decimal string; every monetary calculation uses `bigint` minor units. SQLite monetary columns are
decimal `TEXT`, never `REAL`.

Subscription purchase uses:

```text
paidThrough = max(currentPaidThrough, EVE payment time) + purchased duration
```

Credit invoices only add prepaid balance. Scheduler renews an enabled subscription once when it is
inside `RENEWAL_LEAD_SECONDS` and balance covers current plan price:

```text
paidThrough = max(currentPaidThrough, renewal time) + plan duration
```

Insufficient balance after expiry changes subscription to `past_due`. Entitlement remains usable
through `ENTITLEMENT_GRACE_SECONDS`.

## REST contract

All responses use JSON. All timestamps are Unix seconds. IDs and ISK values are strings. ISK uses
exact two-decimal form, for example `"100000000.00"`.

Authenticated endpoints require the desktop's current EVE access token:

```http
Authorization: Bearer <EVE access JWT>
```

Server validates signature, issuer, expiry, `aud` containing both `"EVE Online"` and the fixed Fly
Safe client ID, optional `azp`, and `sub=CHARACTER:EVE:<id>`. Character ID/name always come from the
verified JWT; request bodies cannot select another character. No subscription is required for these
calls unless stated.

### Public

`GET /healthz`

```json
{"status":"ok"}
```

`GET /v1/plans`

```json
{
  "plans": [{
    "id": "pro-30d",
    "name": "Fly Safe Pro — 30 days",
    "priceIsk": "100000000.00",
    "durationSeconds": 2592000,
    "features": ["wormhole_chain_mapper", "hunter_planner"],
    "enabled": true
  }]
}
```

`GET /v1/keys` returns a JWKS document containing the active Ed25519 public key and `kid`.

### zKillboard/R2Z2 relay

The desktop uses direct public access first. If that connection is blocked or exceeds its short
timeout, it retries through this server with the current verified EVE bearer. A paid subscription
is not required for the relay.

Allowed read-only routes are deliberately fixed:

```text
GET /v1/relay/zkill/api/stats/characterID/:id/kills/
GET /v1/relay/zkill/api/kills/characterID/:id/page/:page/
GET /v1/relay/zkill/api/losses/characterID/:id/page/:page/
GET /v1/relay/zkill/api/systemID/:id/pastSeconds/86400/page/1/
GET /v1/relay/r2z2/sequence.json
GET /v1/relay/r2z2/:sequence.json
```

The client cannot supply an upstream URL, query, fragment, request body, or upstream authorization.
The service rejects redirects, limits response size and time, globally paces starts, deduplicates
identical in-flight reads, and keeps a bounded TTL/LRU memory cache. Configure the fixed upstreams
with `ZKILL_BASE_URL`, `R2Z2_BASE_URL` (origin before `/ephemeral`), and a descriptive
`ZKILL_RELAY_USER_AGENT`. Keep reverse-proxy connection/rate limits enabled as a second boundary.
The relay sees the authenticated character and requested public IDs/sequences, but never receives
raw Local, D-scan, or Probe Scanner clipboard contents.

### Invoices and account

`POST /v1/invoices`

```json
{"planId":"pro-30d"}
```

`POST /v1/credit-invoices`

```json
{"amountIsk":"100000000.00"}
```

Both return HTTP 201:

```json
{
  "invoice": {
    "id": "2aeef502-38d7-4d7e-a625-095577ed2b81",
    "kind": "subscription",
    "planId": "pro-30d",
    "status": "pending",
    "receiverCharacterId": "90000099",
    "amountIsk": "100000000.00",
    "reason": "FS-4K9T2R7Q",
    "createdAt": 1787662800,
    "expiresAt": 1787749200,
    "paidAt": null,
    "paymentJournalId": null
  }
}
```

`GET /v1/invoices/:id` returns the same object and character-scopes lookup. Status becomes `expired`
after invoice expiry; a valid earlier EVE payment may still change it to `paid` after polling.

`GET /v1/account`

```json
{
  "account": {
    "characterId": "90000001",
    "characterName": "Pilot Name",
    "creditBalanceIsk": "0.00",
    "subscription": {
      "id": "uuid",
      "planId": "pro-30d",
      "status": "active",
      "autoRenew": true,
      "paidThrough": 1790254800,
      "updatedAt": 1787662800
    },
    "devices": []
  }
}
```

`PATCH /v1/subscription`

```json
{"autoRenew":false}
```

### Devices and entitlement refresh

`POST /v1/devices`

```json
{"deviceCode":"ELI-AAAA-BBBB-CCCC-DDDD-EEEE","label":"Home PC"}
```

Registration is allowed before payment. Re-registering the same character/device reactivates it.
Default active-device limit is three. `DELETE /v1/devices/:id` revokes the device and its stored
entitlement.

`GET /v1/entitlements/current?deviceCode=ELI-AAAA-BBBB-CCCC-DDDD-EEEE`

Requires a paid subscription or active grace period. Returns HTTP 402 otherwise.

```json
{
  "token": "EVEI2.<payload>.<signature>",
  "entitlement": {
    "id": "uuid",
    "revision": 2,
    "issuedAt": 1787662800,
    "expiresAt": 1790427600,
    "paidThrough": 1790254800,
    "planId": "pro-30d",
    "features": ["wormhole_chain_mapper", "hunter_planner"]
  }
}
```

Response has `ETag: "entitlement-<id>-<revision>"`. Send `If-None-Match`; unchanged token returns
HTTP 304. Recommended desktop refresh: on startup, after payment UI detects `paid`, every 6 hours,
and once per hour during final 72 hours.

### Corp/Fleet shared workspaces

Every workspace call uses the same verified EVE bearer as billing. The acting character is always
derived from JWT `sub`; a body field cannot impersonate another member. It also requires a current
subscription/grace period whose plan contains `corp_fleet_intel`; desktop UI gating is not treated
as authorization. For an active alt without its own entitlement, the client may additionally send
the paid owner's EVE bearer as `X-Fly-Safe-Owner-Authorization: Bearer …`. `Authorization` still
defines the actor. This fallback is considered only after the actor receives a subscription/feature
denial, and the owner must have both `multi_character` and `corp_fleet_intel`. Non-members receive
the same `workspace_not_found` 404 as a missing workspace when reading an existing workspace.
Clients must create unguessable UUID/ULID workspace IDs.

Workspace IDs, mutation IDs, record IDs, character IDs, entity IDs, and solar-system IDs are JSON
strings. Workspace/record/presence revisions and Unix timestamps are JSON numbers. The desktop
shared-domain adapter must convert safe EVE IDs and Unix seconds to its numeric/ISO representation
at the UI boundary; it must keep wire IDs as strings until they pass a safe-integer check.

| Role | Read consented collections | Change records | Manage members | Change policy |
| --- | --- | --- | --- | --- |
| `owner` | yes | yes | yes | yes |
| `commander` | yes | yes | no | no |
| `editor` | yes | yes | no | no |
| `viewer` | yes | no | no | no |

The owner must also accept the current policy before managing members or policy. Record access is
limited to the caller's current explicit scopes: `watchlist`, `doctrines`, and/or `routes`. A new
member can read metadata and the member list before consent, but receives no records. Advancing
`policyVersion` makes every prior consent stale until each character accepts the new version.

All state-changing requests carry a client-generated `mutationId`. Retrying the identical request
returns `applied:false`; reusing that ID for a different actor, operation, target, expected revision,
or payload returns `mutation_id_reused`. Member, consent, and policy changes require an exact
`expectedWorkspaceRevision`. Record changes require the exact per-record `expectedRevision`; a
stale `baseWorkspaceRevision` is allowed and reported as `staleBase:true`, permitting independent
records to merge. Applied record mutations append an immutable change row in the same SQLite
transaction as the record and workspace revision. Record replay returns the immutable record
version produced by that mutation, not a newer record that happens to occupy the same key.

Create and discover:

- `POST /v1/workspaces` — `{workspaceId,name,policyVersion,mutationId}`; creator becomes owner with
  `consent:null`; HTTP 201 on first application and 200 on replay.
- `GET /v1/workspaces` — workspaces containing the JWT character.
- `GET /v1/workspaces/:workspaceId` — filtered snapshot: metadata, members, current consents, and
  only records covered by the caller's current consent.

Members and policy:

- `GET /v1/workspaces/:workspaceId/members`
- `POST /v1/workspaces/:workspaceId/members` — owner only;
  `{characterId,characterName,role,expectedWorkspaceRevision,mutationId}`. New role is
  `commander`, `editor`, or `viewer`.
- `PATCH /v1/workspaces/:workspaceId/members/:characterId` — owner only;
  `{role,expectedWorkspaceRevision,mutationId}`. The owner role cannot be reassigned.
- `DELETE /v1/workspaces/:workspaceId/members/:characterId` — owner only, JSON body
  `{expectedWorkspaceRevision,mutationId}`. The owner cannot be removed.
- `PATCH /v1/workspaces/:workspaceId/policy` — owner only;
  `{policyVersion,expectedWorkspaceRevision,mutationId}`; version must strictly increase.

Consent is self-service only; there is no character ID in these requests:

- `PUT /v1/workspaces/:workspaceId/consent` —
  `{policyVersion,scopes,expectedWorkspaceRevision,mutationId}`.
- `DELETE /v1/workspaces/:workspaceId/consent` — JSON body
  `{expectedWorkspaceRevision,mutationId}`.
- `GET /v1/workspaces/:workspaceId/consent` — caller's auditable consent history, including
  append-only `accepted`/`revoked` events, scopes, `occurredAt`, and `revokedAt`.

Records and sync:

- `GET /v1/workspaces/:workspaceId/records?collection=watchlist` — current records and tombstones;
  omitting `collection` returns every caller-consented collection.
- `POST /v1/workspaces/:workspaceId/mutations` — the shared-domain upsert/delete shape. Response is
  `{result}` with `ok`, `applied`, `staleBase`, snapshot, record, and change; domain conflicts are
  HTTP 200 with `result.ok:false` so the transport can merge the returned `currentRecord`.
- `GET /v1/workspaces/:workspaceId/changes?afterWorkspaceRevision=0&limit=100` — `{page}` with
  consent-filtered changes and current affected records. Limit range is 1–500.

Example record mutation:

```json
{
  "operation": "upsert",
  "mutationId": "01K5MUTATION000000000000001",
  "collection": "watchlist",
  "recordId": "watch-90009999",
  "expectedRevision": 0,
  "baseWorkspaceRevision": 4,
  "payload": {
    "entityType": "character",
    "entityId": "90009999",
    "name": "Known Scout",
    "severity": "danger",
    "tags": ["scout"],
    "note": null
  }
}
```

#### Local Presence privacy boundary

Local Presence is deliberately not a normal shared record and is never inferred from ESI, Local
chat, clipboard data, or another character ID supplied by the client.

- `PUT /v1/workspaces/:workspaceId/presence` accepts only the current JWT character's presence:
  `{solarSystemId,solarSystemName?,ttlSeconds,expectedRevision,mutationId}`. Current explicit
  `local-presence` consent is mandatory. TTL must be 30–300 seconds.
- `GET /v1/workspaces/:workspaceId/presence` requires the caller's current `local-presence` consent
  and returns only unexpired rows belonging to members who also currently consented to that scope.
- `DELETE /v1/workspaces/:workspaceId/presence` clears the caller's row with
  `{expectedRevision,mutationId}` and remains available as a privacy escape hatch even after consent
  is gone.

Accepting scopes without `local-presence`, revoking consent, leaving/removal from the workspace, or
advancing the workspace policy scrubs the affected location immediately. The server retains only a
payload-free monotonic tombstone, preventing a delayed old request from overwriting or deleting a
newer presence after expiry/re-consent (ABA). Expiry is scrubbed on read/write. Presence updates
have their own optimistic revision and do not churn the durable workspace revision/change feed.
Presence mutation IDs are retained for 24 hours—the maximum retry window—then pruned; the monotonic
revision still rejects older delayed writes.

All authenticated workspace responses send `Cache-Control: private, no-store` and vary on both
authorization headers, so roster, intel, and presence are not retained by shared caches after
consent changes.

### Operational endpoints

Use the separate `ADMIN_TOKEN`, never an EVE token:

- `POST /v1/admin/wallet/poll` — force ESI reconciliation, then run renewals.
- `POST /v1/admin/subscriptions/renew` — run renewal pass without ESI.

Normal polling and renewal also run in the background. Concurrent ticks collapse into one process;
database uniqueness and transactions provide final idempotency.

Errors have stable codes:

```json
{
  "error": {
    "code": "subscription_required",
    "message": "Active subscription required"
  },
  "requestId": "uuid"
}
```

## Entitlement V2

Compact form:

```text
EVEI2.base64url(UTF-8 JSON claims).base64url(Ed25519 signature)
signature input = ASCII("EVEI2." + payloadSegment)
```

Claims have this exact order when issued (verifiers should validate fields, not depend on order):

```json
{
  "v": 2,
  "product": "eve-local-intel",
  "kid": "fly-safe-2026-01",
  "entitlementId": "uuid",
  "revision": 2,
  "subscriptionId": "uuid",
  "characterId": "90000001",
  "characterName": "Pilot Name",
  "deviceId": "uuid",
  "deviceCode": "ELI-AAAA-BBBB-CCCC-DDDD-EEEE",
  "planId": "pro-30d",
  "features": ["wormhole_chain_mapper"],
  "issuedAt": 1787662800,
  "notBefore": 1787662500,
  "paidThrough": 1790254800,
  "expiresAt": 1790427600
}
```

Desktop must verify Ed25519 signature, token prefix/version/product, pinned `kid`, exact device code,
`notBefore`, and `expiresAt` before enabling paid features.

Critical key rule: private key configured here must match the public key compiled into
`src/main/license-public-key.ts`. Current desktop only trusts that fixed key. At startup the server
derives the public half of `ENTITLEMENT_PRIVATE_KEY_PATH`, verifies both `ENTITLEMENT_KEY_ID` and its
canonical SPKI SHA-256 fingerprint against `src/desktop-entitlement-trust.ts`, and exits before
opening SQLite or listening when either differs. The check uses public material only. A newly
generated random private key is therefore not a valid quick-start key.

`/v1/keys` supports inspection and a future rotation protocol; it must not silently replace the
pinned key. Safe rotation first ships a desktop release containing the new public trust, then
updates `src/desktop-entitlement-trust.ts` in the coordinated server release, starts issuing the new
`kid`, waits through maximum offline/grace lifetime, and removes the old key in a later release.

To print the public half without exposing private material:

```bash
openssl pkey -in ./secrets/entitlement-private.pem -pubout
```

To verify the exact fingerprint checked at startup without exposing private material:

```bash
openssl pkey -in ./secrets/entitlement-private.pem -pubout -outform DER \
  | openssl dgst -sha256
```

Expected for the current desktop release:
`5925643c4a5c4c61288737898ddfaacc7558422cd35d2f78d73f563c05cd7314` with key ID
`fly-safe-2026-01`.

V1 `EVEI1` is not wire-compatible with V2. The desktop validates both formats through separate
claim parsers; legacy V1 keys remain a migration path while subscriptions use `EVEI2`.

## Source layout

- `src/store.ts` — storage interface, SQLite schema, atomic ledger primitives
- `src/billing-service.ts` — invoice matching, credits, subscriptions, device limits, renewals
- `src/entitlement.ts` — Ed25519 V2 issuance and revision refresh
- `src/esi-wallet.ts` — lossless ESI parsing, caching, retries, poll state
- `src/auth.ts` — EVE JWT/JWKS verification and cashier refresh-token adapter
- `src/workspace-domain.ts` — Corp/Fleet roles, consent, record, change, and presence wire types
- `src/workspace-service.ts` — authenticated permissions, sync, idempotency, and privacy rules
- `src/zkill-relay.ts` — bounded allowlisted zKillboard/R2Z2 relay and memory cache
- `src/http-api.ts` — dependency-free Node HTTP REST API
- `test/` — billing, entitlement, JWT, ESI, workspace privacy/concurrency, and REST contract tests
