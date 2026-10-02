/**
 * The deployment, as the site reads it: `deployments/robinhood-mainnet.json`, embedded in
 * `@hunch-rh/client`, with the rehearsal overrides from .ocean/PLAN.md.
 *
 * - Server code calls `readDeployment()`: `HUNCH_DEPLOYMENT_JSON`, else
 *   `NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON`, else the embedded file.
 * - Client islands call `publicDeployment()`: only `NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON` (written
 *   literally below so Next inlines it into the browser bundle), else the embedded file. It
 *   ignores server-only env on purpose, so a client island renders the same thing on the server
 *   and in the browser.
 *
 * A malformed override never takes the site down and never claims a deployment: it falls back
 * to the committed file, which says "not deployed" until the operator deploys, and says why in
 * the server log.
 */

import { EMBEDDED_DEPLOYMENT, isDeployed, loadDeployment, notDeployed, parseDeployment, type Deployment } from '@hunch-rh/client';

export type { Deployment } from '@hunch-rh/client';

/** Literal, so Next.js inlines it into client bundles. */
const PUBLIC_DEPLOYMENT_JSON = process.env.NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON;

let warned = false;

function embedded(): Deployment {
  return loadDeployment({ env: {} });
}

/** Server components, route handlers and the keeper glue. */
export function readDeployment(): Deployment {
  try {
    return loadDeployment();
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error(`[deployment] ignoring an invalid override: ${(error as Error).message.split('\n')[0]}`);
    }
    return embedded();
  }
}

/** Client islands (and anything that must agree between the server render and the browser). */
export function publicDeployment(): Deployment {
  try {
    return loadDeployment({ json: PUBLIC_DEPLOYMENT_JSON, env: {} });
  } catch {
    return embedded();
  }
}

/** True when Hunch's three contracts have real addresses and the file says "deployed". */
export function isLive(deployment: Deployment): boolean {
  return isDeployed(deployment);
}

/** A deployment in the "not deployed" state (for tests and for the launching templates). */
export const NOT_DEPLOYED: Deployment = notDeployed(parseDeployment(EMBEDDED_DEPLOYMENT, 'embedded'));

/** An address from the deployment, or null while it is the zero placeholder. */
export function addressOrNull(address: string | null | undefined): string | null {
  if (address === null || address === undefined) return null;
  return /^0x0{40}$/i.test(address) ? null : address;
}
