import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge.js";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Open a client, say hello, and report whether the server kept it (resolves true/false). */
function connect(port, { origin, token } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
  let closedByServer = false;
  const settled = new Promise((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, version: "t", sites: ["generic"] })));
    ws.on("close", () => {
      closedByServer = true;
      resolve(false);
    });
    ws.on("error", () => {
      closedByServer = true;
      resolve(false);
    });
    setTimeout(() => {
      if (!closedByServer) resolve(true);
    }, 400);
  });
  return { ws, settled, close: () => ws.close() };
}

async function bridgeWith(token) {
  const bridge = new Bridge({ port: await freePort(), token, log: () => {} });
  await bridge.start();
  return bridge;
}

test("bridge rejects a plain web page origin", async () => {
  const bridge = await bridgeWith("secret-token-123456");
  try {
    const client = connect(bridge.port, { origin: "http://127.0.0.1:5000", token: "secret-token-123456" });
    assert.equal(await client.settled, false);
    assert.equal(bridge.connected, false);
  } finally {
    await bridge.stop();
  }
});

test("bridge rejects an extension with the wrong token, accepts the right one", async () => {
  const bridge = await bridgeWith("secret-token-123456");
  try {
    const bad = connect(bridge.port, { origin: "chrome-extension://aaaa", token: "wrong" });
    assert.equal(await bad.settled, false);
    assert.equal(bridge.connected, false);
    const good = connect(bridge.port, { origin: "chrome-extension://aaaa", token: "secret-token-123456" });
    assert.equal(await good.settled, true);
    assert.equal(bridge.connected, true);
    good.close();
  } finally {
    await bridge.stop();
  }
});

test("a newer authenticated client replaces the old one (MV3 worker restarts)", async () => {
  const bridge = await bridgeWith("secret-token-123456");
  try {
    const first = connect(bridge.port, { origin: "chrome-extension://aaaa", token: "secret-token-123456" });
    assert.equal(await first.settled, true);
    const second = connect(bridge.port, { origin: "chrome-extension://aaaa", token: "secret-token-123456" });
    assert.equal(await second.settled, true, "a restarted worker must be accepted");
    assert.equal(bridge.connected, true);
    // The replacement is the socket the bridge now talks to.
    assert.notEqual(bridge.client, null);
    second.close();
  } finally {
    await bridge.stop();
  }
});

test("a client with a wrong token still cannot displace the authenticated one", async () => {
  const bridge = await bridgeWith("secret-token-123456");
  try {
    const first = connect(bridge.port, { origin: "chrome-extension://aaaa", token: "secret-token-123456" });
    assert.equal(await first.settled, true);
    const original = bridge.client;
    const bad = connect(bridge.port, { origin: "chrome-extension://bbbb", token: "wrong" });
    assert.equal(await bad.settled, false);
    assert.equal(bridge.client, original, "an unauthenticated client must not take over");
    first.close();
  } finally {
    await bridge.stop();
  }
});

test("stop() does not hang while a client is connected", async () => {
  const bridge = await bridgeWith("secret-token-123456");
  const client = connect(bridge.port, { origin: "chrome-extension://aaaa", token: "secret-token-123456" });
  assert.equal(await client.settled, true);
  const started = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - started < 3000, "stop() waited on the live socket instead of terminating it");
});
