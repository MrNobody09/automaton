const originalFetch = globalThis.fetch;

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

if (originalFetch) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (process.env.AUTOMATON_TEST_ALLOW_NETWORK === "1") {
      return originalFetch(input, init);
    }

    let url: URL;
    try {
      if (input instanceof Request) url = new URL(input.url);
      else url = new URL(String(input));
    } catch {
      return originalFetch(input, init);
    }

    if ((url.protocol === "http:" || url.protocol === "https:") && !isLoopback(url.hostname)) {
      throw new Error(
        `External network access is disabled during tests: ${url.origin}. ` +
        "Mock the request or set AUTOMATON_TEST_ALLOW_NETWORK=1 only for an explicitly approved integration test.",
      );
    }

    return originalFetch(input, init);
  }) as typeof fetch;
}
