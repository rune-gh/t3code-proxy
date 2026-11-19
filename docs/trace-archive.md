# Trace archive

Enable `trace-archive.enabled` to keep model calls for evaluation, replay or training. The default is off. The archive works independently of request logging. The web panel provides the switch, directory and recorder status under Logging. Set encryption and upload options in YAML. Settings reload with the hub configuration.

## Privacy and keys

A trace includes instructions, conversation history, tool arguments, tool results, generated content and whatever secrets a user pasted into a session. The live segment for the current UTC day stays local in plaintext (mode 0600 on POSIX) until it seals. Use a private directory on an encrypted volume, restrict its OS permissions to the hub account, and protect exports just as carefully. New directories use mode 0700 and new files use 0600 on POSIX. Set Windows ACLs on the parent directory.

Generate an age identity on the machine where you will read the archives. Keep the private identity there. Back it up somewhere other than the upload destination. Losing every matching identity makes a sealed encrypted segment unrecoverable.

```sh
age-keygen -o trace-identity.txt
age-keygen -y trace-identity.txt
```

Copy only the printed `age1...` public recipient to the hub. Any configured recipient can decrypt. A segment uses the recipients configured when it seals. A hub with public keys alone can read its live file and cannot decrypt sealed history. Enabling the archive requires at least one valid age X25519 recipient. Every newly sealed segment is encrypted.

## Configuration and Google Drive

```yaml
trace-archive:
  enabled: true
  dir: /srv/private/traces
  recipients: [age1REPLACE_WITH_PUBLIC_RECIPIENT]
  queue-size: 32
  max-local-size-mb: 8192
  exclude-models: []
  exclude-endpoints: []
  upload:
    enabled: true
    binary: rclone
    remote: gdrive:t3code-proxy-traces
```

1. Install rclone for the OS user that runs the hub. Run `rclone config`, create a remote named `gdrive`, select Google Drive and authorize the account. Keep rclone's configuration private.
2. Run `rclone mkdir gdrive:t3code-proxy-traces` and `rclone lsf gdrive:t3code-proxy-traces` as the hub user.
3. Apply the config and make a test call. Send an authenticated POST to `/v8/management/trace-archive/seal-now`. Check `GET /v8/management/trace-archive/status` for the segment, verified destination, dropped count and errors.
4. Test recovery on the identity machine. Copy a segment and its matching manifest into one directory, then run `traces verify` and `traces export`.

The default directory is a sibling of the resolved auth directory, with `-traces` appended to its name (for example `~/.t3code-proxy-traces`). An explicit `trace-archive.dir` takes precedence. To continue using a previous archive location, set `dir` to that path. Startup renames legacy `.manifest.json` sidecars there to `.manifest`. Historical plaintext segments remain readable locally and are ineligible for upload. Filters are exact client model names and URL paths. Queue size bounds concurrent captures plus queued calls. A call exceeding the available slots, 128 MiB per call, 256 MiB of aggregate capture buffers, or 256 levels of JSON nesting is dropped whole. Disk, compression, reconstruction, encryption and networking run outside client handlers. Counters for dropped calls reset when the hub restarts. The local limit is in MiB and zero means unlimited. Retention removes the oldest sealed pairs first. With uploads enabled, only a pair verified at the configured destination qualifies. The live segment always stays on disk.

Both files are sent with `rclone copyto`. The hub streams each back with `rclone cat` to check the exact byte length and SHA-256 even on remotes that expose only MD5. This uses bandwidth in both directions. A verified pair has the destination in local and remote manifest field `uploaded_to`. Errors retry in the background with exponential backoff up to one hour. Uploads are cancellable at shutdown.

## Reading a segment without the hub

```sh
age -d -i trace-identity.txt traces-2026-11-20-123.jsonl.zst.age | zstd -dc > restored.jsonl
jq -c 'select(.type == "call") | .call.response' restored.jsonl
```

Schema version 1 uses UTF-8 JSON objects separated by LF, one object per line, including the final LF. Dates are UTC. File names are `traces-YYYY-MM-DD[-n].live` while open and `traces-YYYY-MM-DD[-n].jsonl.zst.age` once sealed. The writer uses a nanosecond suffix to distinguish same-day segments. The date is the recording day. A new day or a manual seal starts an independent blob dictionary. A current-day live file can survive a clean shutdown. Recovery truncates only the unterminated final line, rejects a corrupt complete line and seals stale live files.

Entries appear in this order:

* A header has `type: "header"`, integer `schema_version: 1` and `date`.
* A blob has `type: "blob"`, `sha256` (lowercase hex) and `value` (any JSON value). Hash the UTF-8 canonical JSON value. Objects sort keys by their UTF-8 byte strings recursively, arrays retain order, and separators have no whitespace. Strings use UTF-8 in double quotes. Escape quotes, backslashes and the five short control escapes. Encode other ASCII control characters, `<`, `>` and `&` as lowercase `\u00xx`, and U+2028/U+2029 as `\u2028`/`\u2029`. Numeric literals retain their original spelling, including large integers. Each hash appears once and before its first reference.
* A call has `type: "call"` and a `call` object with its own integer `schema_version`. Its packed `client_request` and `upstream_request` each have a `body` and optional `parts`. Copy body, then insert each parts entry at the same top-level key. A string denotes one blob hash. An array denotes an ordered array of blob hashes. Empty arrays remain empty. Fields eligible for extraction are system, instructions, tools, messages, input, contents, systemInstruction and toolConfig. The `base64` alternative holds a non-JSON request as standard padded Base64. Missing payload fields mean that side was unobserved.
* The call's `response` is the reconstructed upstream object. Claude thinking, signatures, redacted blocks, tools, citations and stop information stay in provider format. Responses items retain opaque encrypted content and summaries. Chat chunks become choices with complete messages and tool calls. For HTTP calls, a differing final client result is stored as `client_response`, or `client_raw_base64` if it cannot be reconstructed. The client-facing body supplies a fallback when upstream capture is unavailable. When reconstruction fails, `raw_frames_base64` contains ordered standard Base64 snapshots of executor chunks (scanner lines, HTTP bodies or WebSocket messages). Base64 decoding recovers each frame independently. Network headers are omitted. MCP authorization fields and recognized credentials in JSON header and metadata containers are masked before blob hashing and storage.
* Metadata includes hub version, client URL path and protocol, user agent, client name when supplied, HTTP or WS transport, stream flag, session lineage, trace and request IDs, provider, executor, non-secret auth index, requested/alias/upstream/response models, effort, tier, status, failure classification and token detail where available. Attempts are ordered by outbound send. The final upstream body is paired with the final response. Times are RFC 3339 UTC. Latency and TTFT are integer nanoseconds. `first_byte` is the first observed HTTP response byte or WS frame. `ttft_ns` uses provider token timing where available and falls back to the first observed response byte. Optional fields can be absent for early failures or providers that omit them.
* A sealed segment ends with `type: "footer"`, `counts` and `sha256`. Hash the exact decompressed bytes of every preceding line **including its LF**. Counts are calls, blobs, unique_blob_bytes, referenced_blob_bytes and jsonl_bytes (before the footer). The dedup ratio divides bytes across all blob references by unique blob bytes. A live segment has no footer.

The sidecar `<sealed filename>.manifest` contains file, date, counts, size (sealed bytes), sha256 (sealed file), source_sha256 (same digest as footer) and optional uploaded_to. The hidden writer lock and temporary files are local implementation details. Export needs only the segment pairs, matching identities for encrypted files and any live segment to include.

To re-inline both requests from a decrypted segment using jq alone:

```sh
jq -nc '
  def unpack($b):
    if has("body") then . as $p | .body +
      (($p.parts // {}) | with_entries(.value |=
        (if type == "array" then map($b[.]) else $b[.] end)))
    else . end;
  foreach inputs as $e ({b:{},call:null};
    .call=null | if $e.type=="blob" then .b[$e.sha256]=$e.value
    elif $e.type=="call" then .b as $b | .call=($e.call |
      if has("client_request") then .client_request |= unpack($b) else . end |
      if has("upstream_request") then .upstream_request |= unpack($b) else . end)
    else . end;
    .call // empty)' restored.jsonl
```

## CLI and management

```sh
t3code-proxy traces stats --dir ./traces
t3code-proxy traces verify --dir ./traces --identity trace-identity.txt
t3code-proxy traces export --dir ./traces --from 2026-11-01 --to 2026-11-20 \
  --identity trace-identity.txt --output calls.jsonl
t3code-proxy traces export --dir ./traces --identity trace-identity.txt \
  --format conversations > sessions.jsonl
```

Date bounds include both endpoints. Omit `--dir` to resolve it from `--config` (default `config.yaml`). Call export writes one resolved record per line. Conversation export groups records by session, putting calls without a session in individual groups. Call export holds one segment's blob dictionary in memory. Conversation export also buffers the grouped records in the selected range. Stats reads sealed manifests without a private identity. Verify checks sealed hashes, age authentication, footer and blob integrity, counts and references. Live files can only be checked through their last complete entry. Output files created with `--output` must be new paths.

Authenticated v8 routes are `GET/PUT /v8/management/trace-archive/settings`, `GET /v8/management/trace-archive/status`, and `POST /v8/management/trace-archive/seal-now`. PUT replaces the settings block. Status includes UTC-day counts and bytes, queue depth, dropped calls, dedup ratio, local manifests and writer/upload errors.
