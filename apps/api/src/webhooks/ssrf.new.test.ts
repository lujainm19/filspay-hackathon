/**
 * New tests for S18 (webhook SSRF) and W4 (capped response reads). No DB needed.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isPrivateAddress } from "./ssrf.js";
import { validateWebhookUrl } from "./create.js";
import { createFetchTransport } from "./transport.js";

test("S18: private, loopback, link-local and metadata addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "[::1]"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("S18: in production, webhook URLs pointing inside our network are refused", () => {
  const prod = { nodeEnv: "production" as const };
  for (const url of ["https://localhost/hook", "https://10.0.0.5/hook", "https://169.254.169.254/latest", "https://settlement.internal/x", "http://example.com/hook"]) {
    assert.throws(() => validateWebhookUrl(url, prod), /invalid_url|public internet/, url);
  }
  assert.equal(validateWebhookUrl("https://merchant.example.com/hook", prod).hostname, "merchant.example.com");
});

test("S18: the production transport refuses to send to a private address", async () => {
  const transport = createFetchTransport({ blockPrivateNetworks: true });
  const res = await transport({ url: "http://127.0.0.1:9/hook", headers: {}, body: "{}", timeoutMs: 1000 });
  assert.equal(res.statusCode, null);
  assert.match(res.errorMessage ?? "", /private address/);
});

test("W4: a huge reply from a receiver is only read up to 4 KB", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(5_000_000));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const transport = createFetchTransport(); // dev/test: local receivers allowed
    const res = await transport({ url: `http://127.0.0.1:${port}/`, headers: {}, body: "{}", timeoutMs: 5000 });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.length <= 4096, `read ${res.body.length} bytes`);
  } finally {
    server.close();
  }
});
