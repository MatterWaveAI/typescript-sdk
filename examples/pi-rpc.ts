/**
 * Drive Pi 1.0 (`pi --mode rpc`) with `client.pi`: build the provider
 * configuration, create the extension factory, and run one prompt over
 * JSON-Lines RPC.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example MATTERWAVE_API_KEY=mw_... \
 *         npx tsx examples/pi-rpc.ts "Summarize src/index.ts"
 */

import {
  MATTERWAVE_PROVIDER_NAME,
  MatterWave,
  type MatterWavePiOptions,
  type PiProviderConfig,
  type PiRpcClientOptions,
} from "../src/index.js";
import { isMain, start, terminal, type Io } from "./io.js";

export interface PiRpcRunOptions extends MatterWavePiOptions {
  rpc?: Omit<PiRpcClientOptions, "client">;
}

export async function run(
  client: MatterWave,
  prompt: string,
  io: Io = terminal,
  options: PiRpcRunOptions = {},
): Promise<number> {
  const { rpc: rpcOptions, ...piOptions } = options;
  const provider = await client.pi.buildProviderConfig(piOptions);
  const registered = new Map<string, PiProviderConfig>();
  const commands: string[] = [];
  const extension = client.pi.createExtension(piOptions);
  await extension({
    registerProvider(name, config) {
      registered.set(name, config);
    },
    registerCommand(name) {
      commands.push(name);
    },
    on() {},
  });
  const active = registered.get(MATTERWAVE_PROVIDER_NAME) ?? provider;
  io.write(`[provider: ${active.baseUrl} (${active.models.length} models, commands: ${commands.join(", ")})]\n`);

  const rpc = client.pi.createRpcClient(rpcOptions);
  try {
    const state = await rpc.getState();
    const done = (async () => {
      for await (const event of rpc.events()) {
        if (event.type === "message_update" && event.assistantMessageEvent?.delta) {
          io.write(event.assistantMessageEvent.delta);
        }
        if (event.type === "agent_end") break;
      }
    })();
    await rpc.prompt(prompt);
    await done;
    io.write(`\n[session ${state.sessionId}: ${active.models[0]?.id ?? "unknown"}]\n`);
    return 0;
  } catch (error) {
    io.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await rpc.close();
  }
}

if (isMain(import.meta.url)) {
  start(async () => {
    if (!process.env.MATTERWAVE_API_KEY) {
      console.error("Set MATTERWAVE_API_KEY to a MatterWave API key.");
      return 2;
    }
    return run(new MatterWave(), process.argv.slice(2).join(" ") || "Summarize this project.");
  });
}
