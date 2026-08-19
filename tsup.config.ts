import { defineConfig } from "tsup";

// One self-contained ESM file with all dependencies inlined. Node.js 22 is
// still required at run time, but no install step is.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  // CommonJS output: commander is a CommonJS package, so this avoids ESM
  // interop shims. tsup emits dist/cli.cjs because the package is ESM-typed.
  format: "cjs",
  target: "node22",
  platform: "node",
  outDir: "dist",
  bundle: true,
  minify: true,
  sourcemap: true,
  clean: true,
  // Inline all runtime dependencies so the file runs without node_modules.
  noExternal: ["commander", "zod"],
  // Keeps import.meta.url (used to find the repository root) working in CJS.
  shims: true,
  // The entry file already has the node shebang; tsup preserves it.
});
