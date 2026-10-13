/**
 * Session keepalive for stdio (single-client) mode.
 *
 * VTOP expires a session after roughly 20 minutes of INACTIVITY — not a fixed
 * lifetime from login, contrary to what the upstream README claimed. That
 * makes an idle timeout, which means a cheap periodic touch keeps the session
 * alive indefinitely. (The multi-user HTTP mode already had a keepalive sweep
 * in http.ts; stdio had nothing, so a local user's session always died after a
 * short break.)
 *
 * The touch is `VtopClient.keepAlive()`, which POSTs a cheap authenticated page
 * and re-persists the session. It no-ops when there is no session, so the timer
 * is safe to leave running from startup.
 *
 * Set VTOP_KEEPALIVE_MINUTES=0 to disable (e.g. to avoid any background
 * traffic to VTOP). The timer is unref'd, so it never keeps the process alive.
 */

import { VtopClient } from "./vtop-client.js";

/** How often to touch VTOP. 5 min sits well inside the ~20 min idle timeout. */
export const DEFAULT_KEEPALIVE_MINUTES = 5;

export function keepaliveMinutes(): number {
  const raw = process.env.VTOP_KEEPALIVE_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_KEEPALIVE_MINUTES;
  const n = Number(raw);
  // Negative or unparseable values disable it rather than misbehaving.
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Start periodic keepalive for a client. Returns a stop function, or null when
 * keepalive is disabled.
 */
export function startKeepalive(client: VtopClient): (() => void) | null {
  const minutes = keepaliveMinutes();
  if (minutes === 0) return null;

  const ms = Math.max(30_000, minutes * 60_000);
  const timer = setInterval(() => {
    void (async () => {
      try {
        const alive = await client.keepAlive();
        if (alive) {
          console.error(
            `VtopMCP: keepalive — session still valid (next touch in ${Math.round(ms / 60_000)}m).`,
          );
        } else if (!client.isAuthenticated) {
          // Nothing to keep alive (never logged in, or already expired). Stay
          // quiet; the next tool call reports NOT_AUTHENTICATED with a plan.
          console.error("VtopMCP: keepalive — no active session.");
        } else {
          console.error(
            "VtopMCP: keepalive — VTOP did not confirm the session (transient?). " +
              "Local state left intact; the next tool call will re-check.",
          );
        }
      } catch (err: unknown) {
        console.error(
          "VtopMCP: keepalive error:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }, ms);

  // Never hold the event loop open just for keepalive.
  timer.unref?.();
  console.error(
    `VtopMCP: session keepalive ON (every ${Math.round(ms / 60_000)} min; ` +
      `VTOP idles out around 20 min). Set VTOP_KEEPALIVE_MINUTES=0 to disable.`,
  );
  return () => clearInterval(timer);
}