import { cleanupOldVolumeBuckets } from "../db/volume.js";

export async function startVolumeCleanupTask() {
  const cleanup = async () => {
    try {
      console.log("[volume] running cleanup task");
      await cleanupOldVolumeBuckets();
    } catch (e) {
      console.error("[volume] cleanup error:", e);
    }
  };

  // Run initial cleanup
  await cleanup();

  // Clean up old volume buckets every hour
  const cleanupInterval = setInterval(cleanup, 60 * 60 * 1000);

  return cleanupInterval;
}
