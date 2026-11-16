import path from "node:path";
export const config = {
  database:
    process.env.DATABASE_URL ||
    "postgres://workspace:workspace@127.0.0.1:54329/workspace",
  origin: process.env.APP_ORIGIN || "http://localhost:5173",
  port: Number(process.env.PORT || 3000),
  data: path.resolve(process.env.DATA_ROOT || ".data"),
  folderRoot: process.env.FOLDER_ROOT || "",
  production: process.env.NODE_ENV === "production",
  key: process.env.ENCRYPTION_KEY || "",
  image: process.env.RUNNER_IMAGE || "ai-workspace-runner:0.1.0",
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 3),
  maxFile: Number(process.env.MAX_FILE_MB || 25) * 1024 * 1024,
  maxAttachments: Number(process.env.MAX_ATTACHMENTS || 10),
  autoHandoff: process.env.ENABLE_AUTO_HANDOFF === "true",
};
export function validateConfig() {
  if (
    ![
      config.maxConcurrent,
      config.maxFile,
      config.maxAttachments,
      config.port,
    ].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new Error(
      "Concurrency, upload limits and port must be positive integers.",
    );
  if (!/^[a-f0-9]{64}$/i.test(config.key))
    throw new Error("Set ENCRYPTION_KEY to 32 random bytes in hex.");
  if (config.production && !config.origin.startsWith("https://"))
    throw new Error("Production requires an HTTPS APP_ORIGIN.");
}
