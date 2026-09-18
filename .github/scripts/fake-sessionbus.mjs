import fs from "node:fs";
import net from "node:net";

const [socket, capture] = process.argv.slice(2);
if (!socket || !capture) throw new Error("usage: fake-sessionbus.mjs SOCKET CAPTURE");

const server = net.createServer((stream) => {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame.method !== "session.hello") continue;
      fs.writeFileSync(capture, `${JSON.stringify(frame)}\n`);
      stream.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })}\n`);
    }
  });
});

server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
