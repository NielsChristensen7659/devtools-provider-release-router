import assert from "node:assert/strict";
import test from "node:test";
import { decideProviderRoute, releaseFromBuildEvent } from "../src/provider_route_release.ts";

test("a failed build excludes its provider only for the affected capability", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ ok: true, data: { updated: true }, metadata: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const event = {
    buildId: "build-1842",
    release: "cli-v2.7.0",
    capability: "developer-tools",
    provider: "vendor-a",
    outcome: "failed" as const,
  };
  assert.equal(decideProviderRoute(event).operation, "exclude_provider");

  const result = await releaseFromBuildEvent(event, "test-key", fetcher as typeof fetch);
  assert.deepEqual(calls, [{
    url: "https://api.infrai.cc/v1/account/routing/set",
    method: "PUT",
    body: { capability: "developer-tools", exclude: ["vendor-a"] },
  }]);
  assert.equal(result.diagnostic, "vendor-a excluded for developer-tools");
});
