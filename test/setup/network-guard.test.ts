import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";

const previousAllowNetwork = process.env.AUTOMATON_TEST_ALLOW_NETWORK;

afterEach(() => {
  if (previousAllowNetwork === undefined) delete process.env.AUTOMATON_TEST_ALLOW_NETWORK;
  else process.env.AUTOMATON_TEST_ALLOW_NETWORK = previousAllowNetwork;
});

describe("test network guard", () => {
  it("blocks external fetch", async () => {
    await expect(fetch("https://example.com/test-network-guard")).rejects.toThrow(
      "External network access is disabled during tests",
    );
  });

  it("blocks external node:http and node:https requests synchronously", () => {
    expect(() => http.request("http://example.com/test-network-guard")).toThrow(
      "External network access is disabled during tests",
    );
    expect(() => https.request("https://example.com/test-network-guard")).toThrow(
      "External network access is disabled during tests",
    );
  });

  it("blocks raw external TCP and TLS connections synchronously", () => {
    expect(() => net.connect({ host: "203.0.113.1", port: 443 })).toThrow(
      "External network access is disabled during tests",
    );
    expect(() => tls.connect({ host: "203.0.113.1", port: 443 })).toThrow(
      "External network access is disabled during tests",
    );
  });

  it("still permits loopback HTTP used by local integration tests", async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ok");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address");
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${address.port}/`, (response) => {
          let content = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { content += chunk; });
          response.on("end", () => resolve(content));
        });
        request.on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
