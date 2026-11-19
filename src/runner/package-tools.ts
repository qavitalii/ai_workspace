import { createInterface } from "node:readline";
import { installPackages } from "./package-client.js";
import { packageToolHandler } from "./package-mcp.js";

const transport = new AbortController();
const input = createInterface({ input: process.stdin });
input.once("close", () => transport.abort());
input.on(
  "line",
  packageToolHandler(
    installPackages,
    (message) => process.stdout.write(JSON.stringify(message) + "\n"),
    transport.signal,
  ),
);
