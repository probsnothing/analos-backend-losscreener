import { startToken2022MintListener } from "./listeners/token2022.js";
import { startLogsListenerForPrograms } from "./listeners/programs.js";
import { startVolumeCleanupTask } from "./tasks/volumeCleanup.js";
import { retry } from "./utils/retry.js";
import { supabase } from "./db/client.js";

async function waitForTables() {
  const check = async () => {
    const t = await supabase.from("tokens").select("mint_address").limit(1);
    if (t.error) throw t.error;
    const e = await supabase.from("events").select("signature").limit(1);
    if (e.error) throw e.error;
    return true;
  };

  await retry(check, {
    retries: 8,
    factor: 1.8,
    minTimeout: 500,
    maxTimeout: 4000,
    onFailedAttempt: (err) => {
      console.warn("Supabase readiness check failed:", err.message);
    },
  });
}

async function main() {
  console.log("Starting Analos indexer v2...");
  await waitForTables();

  const cleanupInterval = await startVolumeCleanupTask();

  const tokenListener = await startToken2022MintListener();
  const logsListener = await startLogsListenerForPrograms();

  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    clearInterval(cleanupInterval);

    try {
      await tokenListener.ws.removeOnLogsListener(tokenListener.subId);
    } catch (e) {
      console.error("Error removing token listener", e);
    }

    for (const subId of logsListener.subIds) {
      try {
        await logsListener.ws.removeOnLogsListener(subId);
      } catch (e) {
        console.error(`Error removing logs listener ${subId}`, e);
      }
    }

    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal error in main loop", e);
  process.exit(1);
});
