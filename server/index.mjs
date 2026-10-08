// White Petal server entry: Cloud Run runs `node server/index.mjs`, so does `npm run dev`.
// Configuration first (env, .env.local, Secret Manager), THEN the app, because modules read process.env at import.
import { loadDotenv, loadGsmSecrets } from "./env.mjs";
loadDotenv();
await loadGsmSecrets();
const { start } = await import("./app.mjs");
const { server, stop } = await start();
// Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests, close the pool, exit.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stop().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });
void server;
