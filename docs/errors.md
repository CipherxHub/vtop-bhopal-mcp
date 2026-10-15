# Errors and troubleshooting

Failures are **structured, not prose**. Every error carries a machine-readable
`structuredContent.error`, so a client can branch on a stable `code` instead of
parsing English.

```json
{
  "ok": false,
  "error": {
    "code": "NOT_AUTHENTICATED",
    "message": "VTOP session expired.",
    "retryable": false,
    "needsUserInput": false,
    "recovery": ["get_captcha", "login"]
  }
}
```

- `message` — short summary, **no recovery prose**. That lives in `recovery`.
- `retryable` — true when repeating the same call could plausibly succeed.
- `needsUserInput` — true when a human must supply something first.
- `recovery` — ordered tool names to call. **Empty means give up** and tell the user.
- `detail` — free-form diagnostic: page markers, underlying axios message.

The human-readable hint is generated from the same table as the structured
payload, so the two cannot drift apart.

---

## The 13 codes

| Code | `retryable` | `needsUserInput` | `recovery` |
|---|---|---|---|
| `NOT_AUTHENTICATED` | no | no | `get_captcha` → `login` |
| `CREDENTIALS_REQUIRED` | no | **yes** | `login` |
| `INVALID_CAPTCHA` | no | no | `get_captcha` → `login` |
| `INVALID_CREDENTIALS` | no | **yes** | *(none — check credentials)* |
| `ACCOUNT_LOCKED` | no | **yes** | *(none — user must contact VIT)* |
| `MAX_LOGIN_ATTEMPTS` | no | **yes** | *(none — reset in a browser)* |
| `SESSION_MISMATCH` | no | no | `get_captcha` → `login` |
| `RECAPTCHA_REQUIRED` | **yes** | no | `get_captcha` → `login` |
| `CAPTCHA_NOT_FOUND` | **yes** | no | `get_captcha` → `login` |
| `TIMEOUT` | **yes** | no | *(none — retry)* |
| `NETWORK` | **yes** | no | *(none — retry)* |
| `ENDPOINT_NOT_FOUND` | no | no | *(none — **do not log in again**)* |
| `UPSTREAM` | **yes** | no | *(none — retry or report)* |

---

## `ENDPOINT_NOT_FOUND` is deliberately its own code

VTOP serves **404** in two unrelated situations:

1. the session is genuinely dead, or
2. the path simply doesn't exist.

Treating (2) as (1) used to throw away a perfectly good session and send you
round the captcha loop for nothing. The session is now verified against a
known-good endpoint before it is condemned.

**If you see `ENDPOINT_NOT_FOUND`, do not log in again.** The session is fine;
the route is wrong or has been renamed. That is a bug — please
[open an issue](https://github.com/CipherxHub/vtop-bhopal-mcp/issues).

---

## Symptom → cause

**Tools don't appear at all.** MCP tools load at session start. Start a **new**
chat after adding the server. Check `claude mcp list` (Claude Code) or
`opencode mcp list` (OpenCode); if the list looks stale in OpenCode, run
`opencode service restart`.

**`node: bad option: --env-file`.** Node older than 20.6. Update Node, or drop
the `--env-file` argument and log in through the chat instead.

**Server won't start (`✗ vtop failed`), no Node error.** Node *exits* on a
missing `--env-file` rather than ignoring it. Either create `.env`, or remove
the argument.

**`RECAPTCHA_REQUIRED`.** VTOP served Google reCAPTCHA instead of the readable
text captcha — usually a datacenter-looking IP, or several recent login
attempts. **Wait a few minutes** before retrying; repeated attempts escalate
VTOP's risk scoring. A residential proxy via `VTOP_PROXY_URL` also helps.

**`INVALID_CAPTCHA` repeatedly.** The captcha expires in 30–60 seconds. Ask for
a fresh one and type the characters yourself rather than relying on a re-read.
After three misreads the assistant should show you the image and ask.

**`SESSION_MISMATCH` (HTTP 404 on login).** The captcha belonged to a different
VTOP session than the login POST. Fetch a **fresh** captcha — don't reuse the
old one.

**`INVALID_CREDENTIALS`.** Check `.env` for typos and stray spaces around `=`.
Try logging in on the VTOP website to confirm.

**`ACCOUNT_LOCKED` / `MAX_LOGIN_ATTEMPTS`.** Stop retrying. These need a human:
reset in a browser, or contact VIT. Repeated automated attempts make it worse.

**`TIMEOUT`.** VTOP is genuinely slow, especially late at night and on result
days. Add `VTOP_TIMEOUT_MS=60000` to `.env`.

**`NETWORK`.** TLS verification can fail behind a TLS-inspecting proxy whose CA
isn't in the OS trust store. The server already merges the OS trust store; if
that's not enough, `VTOP_INSECURE_TLS=1` disables verification — **only on a
network you trust.**

**A tool returns empty data that you can see on the website.** Two possible
causes:

1. **A failure page parsed as success.** VTOP returns **HTTP 200** for "menu not
   available" and "unable to process". Both would otherwise parse as empty
   results. These are detected and raised now — if you are seeing genuine empty
   output, it may be a different message. Please report it.
2. **The page format changed.** Please
   [open an issue](https://github.com/CipherxHub/vtop-bhopal-mcp/issues) with the
   tool name and what you expected.

> **Don't paste raw VTOP pages or screenshots showing personal details.** They
> contain your marks, your registration number and your session cookies.

---

## Before filing an issue

1. Note the **tool name** and the **error code** if you got one.
2. Run `npm run test:all` — 361 offline checks, no account needed. If any fail,
   that's the bug.
3. Describe what you expected vs what you got.

Never include your `.env`, a raw HTML dump, or a screenshot with your details
visible.

---

## Related

- [tools.md](tools.md) — tool reference
- [development.md](development.md) — running the tests
