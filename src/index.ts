import "dotenv/config";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import { loadConfigOrExit, type Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * Entry point: builds the Express app, mounts routes, starts the server.
 * OAuth broker routes and the MCP transport mount here in later phases.
 */

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return app;
}

export function startServer(config: Config, logger: Logger): void {
  const app = createApp();
  app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      "spotify-mcp server listening",
    );
  });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const config = loadConfigOrExit(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  startServer(config, logger);
}
