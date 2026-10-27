import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockVideo = process.env.MOCK_VIDEO_PATH || fileURLToPath(new URL("../../../../新年视频mp4.mp4", import.meta.url));

export default defineConfig({
  plugins: [react(), { name: "local-mock-video", configureServer(server) {
    server.middlewares.use("/mock/new-year.mp4", (request, response) => {
      let size: number;
      try { size = statSync(mockVideo).size; } catch { response.statusCode = 404; response.end("Mock video not found"); return; }
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) { response.statusCode = 416; response.setHeader("Content-Range", `bytes */${size}`); response.end(); return; }
      response.statusCode = match ? 206 : 200;
      response.setHeader("Content-Type", "video/mp4");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Length", end - start + 1);
      response.setHeader("Cache-Control", "no-store");
      if (match) response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      if (request.method === "HEAD") { response.end(); return; }
      createReadStream(mockVideo, { start, end }).on("error", () => response.destroy()).pipe(response);
    });
  } }],
  server: { proxy: {
    "/api": "http://127.0.0.1:3000",
    "/socket.io": { target: "http://127.0.0.1:3000", ws: true }
  } }
});
