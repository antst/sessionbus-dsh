import fs from "node:fs";
import net from "node:net";

const [socket, capture] = process.argv.slice(2);
if (!socket || !capture) throw new Error("usage: fake-open-arguments-sessionbus.mjs SOCKET CAPTURE");
const state = { ready: false };
const save = () => fs.writeFileSync(capture, `${JSON.stringify(state)}\n`);
const server = net.createServer((stream) => {
  let buffer = "";
  const send = (value) => stream.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame.method === "session.hello") {
        send({ id: frame.id, result: {} });
        send({ id: 100, method: "session.open", params: {
          name: "arguments-proof", groups: [], open: { arguments: ["--unsupported"] },
        } });
      } else if (frame.id === 100) {
        state.response = frame;
        state.ready = frame.error?.code === -32009
          && frame.error?.data?.stderr_tail?.includes("open.arguments are not supported by DSH");
        save();
      }
    }
  });
});
server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
