import fs from "node:fs";
import net from "node:net";

const [socket, capture, product, mode] = process.argv.slice(2);
if (!socket || !capture || !product || !["worker", "peer"].includes(mode)) throw new Error("usage: fake-permission-sessionbus.mjs SOCKET CAPTURE PRODUCT worker|peer");
const state = { hello: false, listed: false, ...(mode === "worker" ? { ready: false } : {}) };
const openRequest = { jsonrpc: "2.0", id: 100, method: "session.open", params: { name: "permission-proof", groups: ["lane-primary", "lane-secondary"], open: { model: "deepseek-official/deepseek-v4-flash" } } };
const save = () => fs.writeFileSync(capture, `${JSON.stringify(state)}\n`);

const server = net.createServer((stream) => {
  let buffer = "", session;
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
        if (mode === "worker") stream.write(`${JSON.stringify(openRequest)}\n`);
      } else if (frame.id === 100 && frame.result?.session_id) {
        state.open = { request: openRequest, response: frame }; save();
        session = frame.result.session_id;
        send({ id: 101, method: "turn.execute", params: { session_id: session, run_id: "proof/1", input: "Call sessionbus list." } });
      } else if (frame.id === 100 || frame.id === 101) {
        state.response = frame; save();
      } else if (frame.method === "session.list") {
        state.listed = true; save(); send({ id: frame.id, result: { sessions: [] } });
      } else if (frame.method === "turn.ready") {
        state.ready = frame.params?.state === "done" && frame.params?.outcome === "completed";
        save(); send({ id: frame.id, result: {} });
      }
    }
  });
});

server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
