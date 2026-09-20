import fs from "node:fs";
import net from "node:net";

const [socket, capture, product] = process.argv.slice(2);
if (!socket || !capture || !product) throw new Error("usage: fake-turn-error-sessionbus.mjs SOCKET CAPTURE PRODUCT");
const state = { hello: false, ready: false };
const openRequest = { jsonrpc: "2.0", id: 100, method: "session.open", params: { name: "turn-error-proof", groups: [], open: { model: "deepseek-official/deepseek-v4-flash" } } };
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
        if (frame.params?.product !== product) return send({ id: frame.id, error: { code: -32602, message: `launched product ${product}, got ${frame.params?.product}` } });
        state.hello = true; state.helloParams = frame.params; save(); send({ id: frame.id, result: {} });
        stream.write(`${JSON.stringify(openRequest)}\n`);
      } else if (frame.id === 100 && frame.result?.session_id) {
        state.open = frame; save();
        send({ id: 101, method: "turn.execute", params: { session_id: frame.result.session_id, run_id: "turn-error/1", input: "Never committed" } });
      } else if (frame.id === 102) {
        state.run = frame.result; state.ready = true; save();
      } else if (frame.method === "turn.ready") {
        state.turnReady = frame.params; save(); send({ id: frame.id, result: {} });
        send({ id: 102, method: "turn.status", params: { session_id: state.open.result.session_id, run_id: "turn-error/1" } });
      } else if (frame.id === 100 || frame.id === 101) {
        state.response = frame; save();
      }
    }
  });
});

server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
