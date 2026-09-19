import fs from "node:fs";
import net from "node:net";

const [socket, capture, product] = process.argv.slice(2);
if (!socket || !capture || !product) throw new Error("usage: fake-sessionbus.mjs SOCKET CAPTURE PRODUCT");

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
      if (frame.params?.product !== product) {
        stream.end(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: `launched product ${product}, got ${frame.params?.product}` } })}\n`);
        continue;
      }
      fs.writeFileSync(capture, `${JSON.stringify(frame)}\n`);
      stream.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })}\n`);
    }
  });
});

server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
