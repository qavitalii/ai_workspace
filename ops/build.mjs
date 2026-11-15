import { build } from "esbuild";
await build({
  entryPoints: [
    "src/server/main.ts",
    "src/server/setup.ts",
    "src/server/smoke.ts",
    "src/runner/main.ts",
    "src/runner/permissions.ts",
  ],
  outdir: "dist/node",
  outbase: "src",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
