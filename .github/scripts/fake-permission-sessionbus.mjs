import fs from "node:fs";
import net from "node:net";

const [socket, capture, product, mode] = process.argv.slice(2);
if (!socket || !capture || !product || !["worker", "peer"].includes(mode)) throw new Error("usage: fake-permission-sessionbus.mjs SOCKET CAPTURE PRODUCT worker|peer");
const input = "W087_INPUT_SENTINEL", deliveryInput = "W087_DELIVERY_SENTINEL";
const state = { hello: false, hellos: [], listed: false, ...(mode === "worker" ? { ready: false } : {}) };
const openRequest = { jsonrpc: "2.0", id: 100, method: "session.open", params: { name: "permission-proof", groups: ["lane-primary", "lane-secondary"], open: { model: "deepseek-official/deepseek-v4-flash" } } };
const save = () => fs.writeFileSync(capture, `${JSON.stringify(state)}\n`);

const server = net.createServer((stream) => {
  let admitted, buffer = "", peerDeliverySent = false, session;
  const send = (value) => stream.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  const rejectHello = (frame, detail) => send({ id: frame.id, error: { code: -32602, message: "invalid_hello", data: detail } });
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame.method === "session.hello") {
        const next = frame.params;
        if (next?.product !== product) return rejectHello(frame, `launched product ${product}, got ${next?.product}`);
        if (mode === "peer") {
          if (typeof next.session_id !== "string" || next.session_id === "" || !Array.isArray(next.groups)
            || next.groups.some((group) => typeof group !== "string" || group === "") || new Set(next.groups).size !== next.groups.length
            || next.name === "" || !next.info || typeof next.info !== "object" || Array.isArray(next.info)) return rejectHello(frame, "invalid hello identity");
          if (admitted && (next.product !== admitted.product || JSON.stringify(next.groups) !== JSON.stringify(admitted.groups))) return rejectHello(frame, "invalid rehello identity");
        }
        admitted = structuredClone(next);
        state.hello = true; state.hellos.push(admitted); state.helloParams = admitted; save(); send({ id: frame.id, result: {} });
        if (mode === "worker" && state.hellos.length === 1) stream.write(`${JSON.stringify(openRequest)}\n`);
      } else if (frame.id === 100 && frame.result?.session_id) {
        state.open = { request: openRequest, response: frame }; save();
        session = frame.result.session_id;
        send({ id: 101, method: "turn.execute", params: { session_id: session, run_id: "proof/1", input } });
      } else if (frame.id === 100 || frame.id === 101) {
        state.response = frame; save();
      } else if (frame.id === 102) {
        state.run = frame.result; save();
        send({ id: 103, method: "message.deliver", params: { run_id: "proof/2", message_id: "delivery-proof", from: { session_id: "source", product: "dsh", groups: [] }, body: deliveryInput } });
      } else if (frame.id === 103) {
        state.deliveryReceipt = frame.result; save();
      } else if (frame.id === 104) {
        state.deliveryRun = frame.result;
        state.ready = state.run?.state === "done" && state.run?.result?.outcome === "completed" && frame.result?.state === "done" && frame.result?.result?.outcome === "completed";
        save();
      } else if (frame.method === "session.list") {
        const identity = mode === "peer" ? {
          session_id: admitted.session_id, kind: "peer", product: admitted.product,
          ...(admitted.name === undefined ? {} : { name: admitted.name }), groups: admitted.groups,
          connected: true, running: true, info: admitted.info,
        } : undefined;
        state.listed = true; state.listedIdentity = identity; save();
        send({ id: frame.id, result: { sessions: identity ? [identity] : [] } });
        if (mode === "peer" && !peerDeliverySent) {
          peerDeliverySent = true;
          send({ id: 200, method: "message.deliver", params: { message_id: "peer-delivery-proof", from: { session_id: "other-peer", name: "Other", product: "dashi", groups: ["web-proof"] }, body: deliveryInput } });
        }
      } else if (frame.id === 200) {
        state.peerDeliveryReceipt = frame.result; save();
      } else if (frame.method === "turn.ready") {
        state.turnReady = frame.params; save(); send({ id: frame.id, result: {} });
        const statusID = frame.params.run_id === "proof/1" ? 102 : 104;
        send({ id: statusID, method: "turn.status", params: { session_id: session, run_id: frame.params.run_id } });
      }
    }
  });
});

server.listen(socket);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
