/**
 * Sign in from a terminal by device code, either of two ways.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example npx tsx examples/device-sign-in.ts key
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example npx tsx examples/device-sign-in.ts person
 *
 * `key` is the API's own device flow: the person approves the code in a
 * browser where they are signed in, and the poll returns an API key (with
 * `chat:read` and `chat:write`) that acts as them. `person` signs them in at
 * the deployment's identity provider instead and returns their own token,
 * which the routes that manage the organisation require;
 * `session(token).accessToken` keeps it fresh. Either way, store the
 * credential in the OS keyring or the editor's secret storage, never a
 * dotfile; this example only prints who it acts as.
 */

import { APIError, DeviceAuthError, MatterWave, MatterWaveError, type ClientOptions, type DeviceCode } from "../src/index.js";
import { isMain, start, terminal, type Io } from "./io.js";

/** `options` is where the deployment is (`baseUrl`, or MATTERWAVE_BASE_URL) and how to reach it (`fetch`); the credentials are the sign-in's. */
export async function run(
  options: ClientOptions,
  mode: "key" | "person",
  io: Io = terminal,
  timeoutMs = 600_000,
): Promise<number> {
  const client = new MatterWave({ ...options, apiKey: null }); // signing in needs no credential
  const onCode = (code: DeviceCode) => io.write(`Open ${code.verification_uri} and enter ${code.user_code}\n`);
  try {
    let signedIn: MatterWave;
    if (mode === "key") {
      const token = await client.auth.device.login({ onCode, timeoutMs, clientName: "example" });
      signedIn = new MatterWave({ ...options, apiKey: token.access_token });
    } else {
      const person = client.auth.person;
      const session = person.session(await person.login({ onCode, timeoutMs }));
      signedIn = new MatterWave({ ...options, apiKey: null, accessToken: session.accessToken });
    }
    const me = await signedIn.me();
    io.write(`signed in as ${me.email ?? me.subject} (${me.org_role ?? "no org role"})\n`);
    return 0;
  } catch (error) {
    if (error instanceof DeviceAuthError) io.error(`not signed in: ${error.code}`);
    else if (error instanceof APIError) io.error(`failed: ${error.status} ${error.code} ${error.requestId}`);
    else if (error instanceof MatterWaveError) io.error(`failed: ${error.message}`);
    else throw error;
    return 1;
  }
}

if (isMain(import.meta.url)) {
  start(async () => {
    const mode = process.argv[2] ?? "key";
    if (mode !== "key" && mode !== "person") {
      console.error("usage: device-sign-in.ts [key|person]");
      return 2;
    }
    return run({}, mode);
  });
}
