# Wire Contract — pixel-request-chunks

This document is the **source of truth** for the wire protocol between the JS client (`pixel-request-chunks`) and the PHP server (`pixel/request-chunks`).

Both packages MUST conform to this contract. Any breaking change MUST bump the wire version (see [Versioning](#versioning)).

---

## Versioning

- **Current wire version:** `1`
- Every request from the JS client MUST send the header:

  ```
  X-Pixel-Request-Chunks-Version: 1
  ```

- The PHP server MUST reject requests with a missing or unsupported version header with HTTP `400` and error code `unsupported_wire_version`.
- **Breaking change policy:** any change to request shape, response shape, error codes, header semantics, or checksum algorithm bumps the wire version to `2`. There is no negotiation — clients and servers must match major versions.

---

## Required headers (all endpoints)

| Header | Value | Required |
|---|---|---|
| `X-Pixel-Request-Chunks-Version` | `1` | yes |
| `Content-Type` | `application/json` for `/start` and `/complete`; `multipart/form-data` for `/chunk` | yes |
| `Accept` | `application/json` (recommended) | no |

The user's whitelisted headers (e.g., `Authorization`, `X-CSRF-TOKEN`) are sent as part of the JSON body of `/start` (in the `headers` field), **not** as transport headers on the chunk endpoints. They are stored server-side and replayed onto the forwarded internal request at `/complete`.

---

## Endpoints

All endpoints live under the configurable prefix (default `/chunk-transport`).

### `POST /chunk-transport/start`

Initiates an upload session.

**Request body (JSON):**

```json
{
  "targetUrl": "/api/invoice",
  "method": "POST",
  "contentType": "multipart/form-data; boundary=----WebKitFormBoundaryXXX",
  "totalBytes": 15728640,
  "totalChunks": 15,
  "chunkSize": 1048576,
  "checksum": "sha256:abc123...",
  "headers": {
    "Authorization": "Bearer ...",
    "X-CSRF-TOKEN": "..."
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `targetUrl` | string | yes | Relative path only. MUST start with `/`, MUST NOT start with `//`, MUST NOT contain `://`, MUST NOT match any `forbidden_target_prefixes`. |
| `method` | string | yes | HTTP method to use on the forwarded request (`POST`, `PUT`, `PATCH`, `DELETE`). |
| `contentType` | string | yes | Exact `Content-Type` of the original request, including `multipart/...` boundary if applicable. Replayed verbatim onto the forwarded request. |
| `totalBytes` | integer | yes | Total payload size in bytes. MUST be ≤ `max_total_bytes`. |
| `totalChunks` | integer | yes | Number of chunks the client will send. MUST be ≤ `max_chunks`. MUST equal `ceil(totalBytes / chunkSize)`. |
| `chunkSize` | integer | yes | Byte size used for chunks 0..N-2. The last chunk MAY be smaller. |
| `checksum` | string | yes | `sha256:<hex>` of the full payload. |
| `headers` | object | no | Whitelisted headers to forward to the target route. Server drops any key not in `forwarded_headers` config. |

**Response (200 OK, JSON):**

```json
{
  "uploadId": "uuid-v4",
  "expiresAt": "2026-04-25T15:30:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `uploadId` | string | UUID v4. Used as the session key for `/chunk` and `/complete`. |
| `expiresAt` | string | ISO-8601 UTC timestamp. After this time, the session is purged. |

**Errors:** see [Error codes](#error-codes).

---

### `POST /chunk-transport/chunk`

Uploads a single chunk. Idempotent on `(uploadId, chunkIndex)`.

**Request (`multipart/form-data`):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `uploadId` | string | yes | From `/start` response. |
| `chunkIndex` | integer | yes | 0-based. Range: `0 .. totalChunks - 1`. |
| `chunkChecksum` | string | yes | `sha256:<hex>` of this chunk's bytes. |
| `chunk` | binary (file part) | yes | Raw chunk bytes. |

**Response (200 OK, JSON) — first successful upload of this index:**

```json
{ "received": true, "chunkIndex": 5 }
```

**Response (409 Conflict, JSON) — chunk already received (idempotent replay):**

```json
{ "received": true, "chunkIndex": 5, "duplicate": true }
```

The server MUST NOT re-write or overwrite a chunk that already exists with a matching checksum. If the same `chunkIndex` arrives with a *different* checksum, the server MUST respond `400 chunk_checksum_mismatch`.

**Errors:** see [Error codes](#error-codes).

---

### `POST /chunk-transport/complete`

Triggers reassembly and forwarding to the target route.

**Request body (JSON):**

```json
{ "uploadId": "uuid-v4" }
```

**Response — pass-through:**

The body, status, and headers from the forwarded target route are returned as-is. The client MUST treat this response as if it had come directly from `targetUrl`.

The server MAY add a single response header to mark the pass-through:

```
X-Pixel-Request-Chunks-Forwarded: 1
```

**Errors before forwarding** (these are package-level errors, not target-route errors): see [Error codes](#error-codes).

**Errors from the target route** are passed through unchanged (e.g., `422` validation errors with the route's own JSON body).

---

## Error codes

All package-level errors return JSON in the shape:

```json
{
  "error": {
    "code": "session_not_found",
    "message": "Human-readable description.",
    "details": { }
  }
}
```

| HTTP | `code` | When | `details` |
|---|---|---|---|
| 400 | `invalid_request` | request body validation failed | field errors keyed by input name |
| 400 | `unsupported_wire_version` | `X-Pixel-Request-Chunks-Version` missing or not `1` | `{ "supported": [1] }` |
| 400 | `invalid_target_url` | `targetUrl` fails relative-only validation | `{ "reason": "absolute" \| "scheme" \| "forbidden_prefix" }` |
| 400 | `payload_too_large` | `totalBytes` > `max_total_bytes` | `{ "limit": number }` |
| 400 | `too_many_chunks` | `totalChunks` > `max_chunks` | `{ "limit": number }` |
| 400 | `chunk_checksum_mismatch` | `/chunk` body hash ≠ `chunkChecksum` | `{ "chunkIndex": number }` |
| 400 | `full_checksum_mismatch` | reassembled bytes hash ≠ `/start` `checksum` | `{ }` |
| 400 | `incomplete` | `/complete` called with missing chunks | `{ "missingChunks": number[] }` |
| 404 | `session_not_found` | unknown `uploadId` | `{ }` |
| 410 | `session_expired` | session past `expiresAt` | `{ }` |
| 429 | `rate_limited` | IP exceeded `max_sessions_per_ip_per_second` on `/start` | `{ "retryAfter": number }` |

All other (non-2xx) responses from `/complete` that did NOT originate from the package itself are forwarded responses from the target route.

The JS client treats any non-2xx final response as `target_failed` unless the response body contains a package error code. When snapshots are enabled, the thrown `UploadError` includes `snapshotId` and the original `Response`.

---

## Checksums

- Algorithm: **SHA-256**, mandatory, no toggle in v1.
- Wire format: lowercase hex prefixed with `sha256:`, e.g. `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Per-chunk checksums are verified at `/chunk` time (fail fast).
- The full-payload checksum is verified at `/complete` after reassembly, before forwarding.

---

## `targetUrl` validation (relative-only)

The server MUST reject `targetUrl` if **any** of the following is true:

1. Does not start with `/`
2. Starts with `//` (protocol-relative)
3. Contains `://` (absolute URL)
4. Starts with any value in `forbidden_target_prefixes` config (loop prevention)

External URLs are explicitly out of scope for v1.

---

## Header forwarding

- Only headers whose **name** appears in the server's `forwarded_headers` whitelist are stored on `/start` and replayed onto the forwarded internal request at `/complete`.
- `Content-Type` is **not** part of the whitelist. It is preserved separately from the `contentType` field of `/start` (so the multipart boundary survives).
- All other headers from `/start`'s `headers` object are silently dropped server-side.

---

## Forwarding mechanism (server-side, informative)

The PHP server reassembles the payload to a temporary buffer, builds a `Symfony\Component\HttpFoundation\Request` via `Request::create(...)` with the original method, content type, whitelisted headers, and raw body, then dispatches it through Laravel's HTTP kernel via `app()->handle($request)`. **No HTTP loopback** — the forwarded request never leaves the PHP process. The target route's middleware stack (auth, validation, etc.) runs normally on the forwarded request.

This is an implementation detail, but it constrains the contract: the target route MUST be reachable through the same Laravel app instance that handles the chunk endpoints. Cross-app forwarding is out of scope.

---

## Compatibility guarantee

A v1 client speaks to a v1 server. Any change to:

- request/response field names or types
- error code names or HTTP status mapping
- checksum algorithm or wire format
- the meaning of any header

…bumps the wire version to `2`. There is no in-band negotiation. Mismatched versions fail fast with `unsupported_wire_version`.
