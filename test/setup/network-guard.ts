import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const originalFetch = globalThis.fetch;
const originalHttpRequest = http.request.bind(http);
const originalHttpGet = http.get.bind(http);
const originalHttpsRequest = https.request.bind(https);
const originalHttpsGet = https.get.bind(https);
const originalNetConnect = net.connect.bind(net);
const originalNetCreateConnection = net.createConnection.bind(net);
const originalTlsConnect = tls.connect.bind(tls);

function networkAllowed(): boolean {
  return process.env.AUTOMATON_TEST_ALLOW_NETWORK === "1";
}

function isLoopback(hostname: string | undefined | null): boolean {
  if (!hostname) return true;
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function deny(hostname: string, api: string): never {
  throw new Error(
    `External network access is disabled during tests (${api}): ${hostname}. ` +
    "Mock the request or set AUTOMATON_TEST_ALLOW_NETWORK=1 only for an explicitly approved integration test.",
  );
}

function hostnameFromHttpArgs(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    try {
      return new URL(String(first)).hostname;
    } catch {
      return undefined;
    }
  }
  if (first && typeof first === "object") {
    const options = first as { hostname?: unknown; host?: unknown };
    const value = options.hostname ?? options.host;
    return typeof value === "string" ? value.split(":")[0] : undefined;
  }
  return undefined;
}

function hostnameFromSocketArgs(args: unknown[]): string | undefined {
  const first = args[0];
  const second = args[1];
  if (first && typeof first === "object") {
    const options = first as { host?: unknown };
    return typeof options.host === "string" ? options.host : undefined;
  }
  return typeof second === "string" ? second : undefined;
}

function assertHttpArgsAllowed(args: unknown[], api: string): void {
  if (networkAllowed()) return;
  const hostname = hostnameFromHttpArgs(args);
  if (!isLoopback(hostname)) deny(hostname!, api);
}

function assertSocketArgsAllowed(args: unknown[], api: string): void {
  if (networkAllowed()) return;
  const hostname = hostnameFromSocketArgs(args);
  if (!isLoopback(hostname)) deny(hostname!, api);
}

if (originalFetch) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (networkAllowed()) return originalFetch(input, init);

    let url: URL;
    try {
      if (input instanceof Request) url = new URL(input.url);
      else url = new URL(String(input));
    } catch {
      return originalFetch(input, init);
    }

    if ((url.protocol === "http:" || url.protocol === "https:") && !isLoopback(url.hostname)) {
      deny(url.hostname, "fetch");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

http.request = ((...args: Parameters<typeof http.request>) => {
  assertHttpArgsAllowed(args, "http.request");
  return originalHttpRequest(...args);
}) as typeof http.request;
http.get = ((...args: Parameters<typeof http.get>) => {
  assertHttpArgsAllowed(args, "http.get");
  return originalHttpGet(...args);
}) as typeof http.get;
https.request = ((...args: Parameters<typeof https.request>) => {
  assertHttpArgsAllowed(args, "https.request");
  return originalHttpsRequest(...args);
}) as typeof https.request;
https.get = ((...args: Parameters<typeof https.get>) => {
  assertHttpArgsAllowed(args, "https.get");
  return originalHttpsGet(...args);
}) as typeof https.get;
net.connect = ((...args: Parameters<typeof net.connect>) => {
  assertSocketArgsAllowed(args, "net.connect");
  return originalNetConnect(...args);
}) as typeof net.connect;
net.createConnection = ((...args: Parameters<typeof net.createConnection>) => {
  assertSocketArgsAllowed(args, "net.createConnection");
  return originalNetCreateConnection(...args);
}) as typeof net.createConnection;
tls.connect = ((...args: Parameters<typeof tls.connect>) => {
  assertSocketArgsAllowed(args, "tls.connect");
  return originalTlsConnect(...args);
}) as typeof tls.connect;
