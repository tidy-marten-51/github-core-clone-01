// Entry point for the forge: this file owns the process lifecycle, app.ts owns the server.
//
// The harness settles the lifecycle, so the shape of this file is fixed even though the
// wording is mine:
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 inside a trial
//      container). If it is missing there is nobody to register with: say so on
//      stderr and exit 1 without doing anything else.
//   2. Build the app server and listen on port 0, letting the kernel pick a free
//      ephemeral port. Port 8080 is never ours to bind — the env owns it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register so the env learns where to
//      dial us. The env notes the source address plus N as our base URL. The first
//      registration wins: a 409 means someone else got there first and is not an
//      error for us. A 400 or 405 is a contract violation and is fatal. Anything
//      else — a refused connection, a timeout, an odd status — just means the env
//      is still starting, so we wait and try again.
//   4. Poll GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers immediately ({"done": false} while the suite runs), so this is a
//      poll loop, never a long-held request. The process must not exit before the
//      env says done: only then does the env write the export the scorer reads.
//   5. Close the server and exit 0.
//
// The only import is the app itself — no packages, no Node built-ins, no model calls.

import { createApp } from './app.ts';

/** How long a single register or done request may run before we abandon it and retry. */
const ENV_CALL_TIMEOUT_MS = 30_000;

/** Retry waits double from this floor... */
const BACKOFF_FLOOR_MS = 250;
/** ...but never grow past this ceiling. */
const BACKOFF_CEILING_MS = 2_000;

/** Marker for a fatal contract answer from the env, as opposed to a transient failure. */
class ContractError extends Error {}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait before the next retry, given how many attempts have already failed:
 * exponential from BACKOFF_FLOOR_MS with the exponent clamped, capped at the ceiling.
 */
function backoffMs(failures: number): number {
  const grown = BACKOFF_FLOOR_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_CEILING_MS, grown);
}

/** The env's origin with any trailing slashes stripped, or '' when the variable is unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

/**
 * Announce our bound port to the env. Returns once a registration stands — ours
 * (200) or an earlier one that beat us to it (409). Transient failures retry
 * forever; a 400/405 answer throws ContractError and ends the program.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        const detail = await response.text();
        throw new ContractError(`register answered HTTP ${response.status}: ${detail}`);
      }
      // Any other status: the env is mid-startup or unhappy — fall through and retry.
    } catch (err) {
      if (err instanceof ContractError) throw err;
      // A network-level failure (refused, reset, timed out) is retryable too.
    }
    await pause(backoffMs(failures));
  }
}

/** Poll the env's /done endpoint until it reports the trial over. Never returns early. */
async function awaitDone(origin: string): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (typeof payload === 'object' && payload !== null && (payload as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // Unreachable env, slow env, malformed body: all of them mean "not done yet".
    }
    await pause(backoffMs(failures));
  }
}

/** The whole life of the process: bind, announce, wait, close. */
async function run(origin: string): Promise<void> {
  const server = createApp();

  // Bind first: registration needs the actual port number the kernel picked.
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  process.stdout.write(`[entry] listening on port ${boundPort}\n`);

  await announcePort(origin, boundPort);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone(origin);
  server.close();
  process.stdout.write('[entry] done\n');
}

const origin = envOrigin();
if (origin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

try {
  await run(origin);
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
