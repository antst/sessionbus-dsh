import fs from "node:fs";
import net from "node:net";

const [socket, capture, product, openCapture, openGroupsJSON] = process.argv.slice(2);
if (!socket || !capture || !product) throw new Error("usage: fake-sessionbus.mjs SOCKET CAPTURE PRODUCT");
const openGroups = openGroupsJSON === undefined ? undefined : JSON.parse(openGroupsJSON);
const openRequest = openGroups === undefined ? undefined : { jsonrpc: "2.0", id: 2, method: "session.open", params: { name: "proof@fake", groups: openGroups, open: {} } };

const server = net.createServer((stream) => {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (openRequest && frame.id === openRequest.id && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))) {
        fs.writeFileSync(openCapture, `${JSON.stringify({ request: openRequest, response: frame })}\n`);
        continue;
      }
      if (frame.method !== "session.hello") continue;
      if (frame.params?.product !== product) {
        stream.end(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: `launched product ${product}, got ${frame.params?.product}` } })}\n`);
        continue;
      }
      fs.writeFileSync(capture, `${JSON.stringify(frame)}\n`);
      stream.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })}\n`);
      if (openRequest) stream.write(`${JSON.stringify(openRequest)}\n`);
    }
  });
});

server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
