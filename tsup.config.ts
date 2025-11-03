import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: false,
  // Bundle ESM-only deps so require() works in CJS build
  noExternal: ["@analosfork/damm-sdk", "@analosfork/dynamic-bonding-curve-sdk"],
  outExtension: () => ({
    js: ".cjs",
  }),
});
