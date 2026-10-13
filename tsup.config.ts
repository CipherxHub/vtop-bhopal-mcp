import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  // Optional dependency, loaded lazily only when REDIS_URL is set. Keep it
  // external so the bundle builds (and stdio users run) without it installed.
  external: ["ioredis"],
  clean: true,
  sourcemap: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
