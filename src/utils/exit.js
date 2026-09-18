/**
 * Exiting cleanly.
 *
 * Two opposite failure modes, both seen in practice on Windows:
 *
 *   - `process.exit()` immediately after `client.destroy()` lands while
 *     discord.js is still tearing down its WebSocket, and the process dies with
 *     a libuv assertion (`UV_HANDLE_CLOSING`) instead of exiting.
 *   - Setting only `process.exitCode` and waiting for the event loop to drain
 *     can hang for 30+ seconds on HTTP keep-alive sockets that nothing is
 *     waiting for.
 *
 * So: ask for a clean exit, then force one shortly after if the loop has not
 * drained by itself. The timer is unref'd, so if everything does close in time
 * the process exits naturally and the timer never fires.
 */
export function exitSoon(code = 0, graceMs = 1500) {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), graceMs);
  timer.unref();
}
