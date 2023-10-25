import { serveEncodedDefinition } from "@composedb/devtools-node";
import {CeramicHost, GenerateFile} from "./config.mjs";

/**
 * Runs GraphiQL server to view & query composites.
 */
const server = await serveEncodedDefinition({
  ceramicURL: CeramicHost,
  graphiql: true,
  path: `${GenerateFile}.json`,
  port: 5001,
});

// @ts-ignore
console.log(`Server started on ${server.url}`);

process.on("SIGTERM", () => {
  // @ts-ignore
  server.close(() => {
    console.log("Server stopped");
  });
});
