export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureSchema } = await import("@/lib/bootstrap");
    const { getEngine } = await import("@/lib/engine");
    try {
      await ensureSchema();
    } catch {
      /* engine degrades gracefully; schema retried on access */
    }
    getEngine().start();
  }
}
