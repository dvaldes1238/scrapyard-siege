import { defineConfig, type Connect, type Plugin } from "vite";

/** ?selftest=1 POSTs its report here; it is printed in the dev/preview server log. */
function selftestReport(): Plugin {
  const handler: Connect.SimpleHandleFunction = (req, res) => {
    let body = "";
    req.on("data", (chunk: unknown) => {
      if (body.length < 100_000) body += String(chunk);
    });
    req.on("end", () => {
      console.log(`[selftest] ${body}`);
      res.end("ok");
    });
  };
  return {
    name: "selftest-report",
    configureServer(server) {
      server.middlewares.use("/__selftest", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__selftest", handler);
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so dist/ works at a domain root or in a subfolder
  // (GitHub Pages project sites, itch.io's CDN paths).
  base: "./",
  plugins: [selftestReport()],
  // Havok loads its .wasm via import.meta.url; pre-bundling breaks that path.
  optimizeDeps: { exclude: ["@babylonjs/havok"] },
  server: { port: 5391, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 8000 },
});
