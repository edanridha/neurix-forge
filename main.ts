// Neurix Forge — process entrypoint.
//
// The trial harness runs this file next to its env service and expects a small
// handshake dance from us:
//
//   1. bring the forge's HTTP server up on a port the kernel picks,
//   2. tell the env which port that turned out to be (POST /register),
//   3. keep asking the env whether the suite is finished (GET /done),
//   4. once it says yes, shut the server down and exit successfully.
//
// The env's origin arrives through MAKEFUN_ENV_URL. Without it there is nobody
// to register with and nobody to serve, so the process refuses to start.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

// Backoff schedule shared by the register and polling loops: start quick,
// double after every failure, never sleep longer than the cap.
const BACKOFF_FIRST_MS = 100;
const BACKOFF_CAP_MS = 2_000;

// A single env request gets this long before we count it as failed; the env
// answers immediately, so a slow answer means something is wrong and a retry
// is the better move. Requests are never left hanging.
const REQUEST_TIMEOUT_MS = 10_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelay(current: number): number {
  return Math.min(current * 2, BACKOFF_CAP_MS);
}

/** POST our bound port to the env until it accepts the registration. */
async function announcePort(envOrigin: string, port: number): Promise<void> {
  const target = `${envOrigin}/register`;
  const payload = JSON.stringify({ port });
  let delay = BACKOFF_FIRST_MS;
  for (;;) {
    try {
      const reply = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Drain the body so the connection can be reused/closed cleanly.
      await reply.text();
      if (reply.ok) return;
    } catch {
      // Network-level failure: fall through to the retry below.
    }
    await pause(delay);
    delay = nextDelay(delay);
  }
}

/** Ask the env whether the suite has finished; true only on an explicit yes. */
async function askIfFinished(envOrigin: string): Promise<boolean> {
  const reply = await fetch(`${envOrigin}/done`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!reply.ok) throw new Error(`/done answered HTTP ${reply.status}`);
  const body: unknown = await reply.json();
  return typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
}

/** Poll /done with backoff until the env reports the suite is finished. */
async function waitUntilFinished(envOrigin: string): Promise<void> {
  let delay = BACKOFF_FIRST_MS;
  for (;;) {
    let finished = false;
    try {
      finished = await askIfFinished(envOrigin);
      // A clean "not yet" is not a failure: reset the backoff so a healthy
      // env is polled at the brisk starting cadence.
      delay = BACKOFF_FIRST_MS;
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause(delay);
    delay = nextDelay(delay);
  }
}

function closeAndExit(server: Server): void {
  server.close(() => process.exit(0));
  // Belt and braces: if a lingering connection keeps close() waiting, still
  // exit promptly — the run is over either way.
  setTimeout(() => process.exit(0), 1_000).unref();
}

async function run(): Promise<void> {
  const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envOrigin === '') {
    console.error('main: MAKEFUN_ENV_URL is not set; there is no env to register with, exiting.');
    process.exit(1);
  }

  const server = createApp();
  server.on('error', (err: Error) => {
    console.error(`main: forge server failed: ${err.message}`);
    process.exit(1);
  });

  // Port 0 asks the kernel for a free ephemeral port; no host argument means
  // every interface, so the env can reach us however it dials back.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('main: could not determine the bound port.');
    process.exit(1);
  }

  await announcePort(envOrigin, address.port);
  await waitUntilFinished(envOrigin);
  closeAndExit(server);
}

void run();
