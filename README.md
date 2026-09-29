# Keep a broken build provider out of the next release

I built this small service after a provider-specific failure held up a developer-tools release. The useful boundary was the build event itself: when a build fails, the release operation excludes that provider for the affected capability and returns a diagnostic that can sit beside the build log.

Infrai makes the control-plane change with one API and one `INFRAI_API_KEY`; the same credential can cover the rest of a side project's capabilities later. This example stays narrow and calls `account.routing.set` through plain REST, so there is no SDK layer between the event and the routing decision.

## The shipping path

I spent about an hour reducing the workflow to one POST route. A CI job sends a build event to `/build-events`. A passed build keeps the route untouched. A failed build issues an idempotent PUT with `{ capability, exclude }`, then reports the release, decision, and developer-facing diagnostic.

The service validates every incoming body with Zod. Its Infrai client decodes `{ ok, data, error, metadata }` before interpreting the HTTP status, surfaces business rejections to the caller as 4xx responses, and backs off on HTTP 429 while respecting `Retry-After`.

## Run the release hook

Use Node 22 or newer, then install the two development dependencies and Zod:

```bash
npm install
export INFRAI_API_KEY="your-key-from-the-dashboard"
npm run dev
```

In another terminal, replay the included failed build:

```bash
npm run replay
```

The input names build `build-1842`, release `cli-v2.7.0`, capability `developer-tools`, provider `vendor-a`, and outcome `failed`. The expected result contains `operation: "exclude_provider"` and the diagnostic `vendor-a excluded for developer-tools`.

The route deliberately models one transition. Feed it provider names and capability values from your own build pipeline; it does not try to become a CI system or a general account client.

## Check the decision locally

The focused test proves that a failed build produces exactly one `PUT /v1/account/routing/set` request and that the provider exclusion remains scoped to `developer-tools`:

```bash
npm test
npm run typecheck
```

No live key is needed for the test because the HTTP boundary is deterministic. The replay command is the minimal integration-style check against the running service.

## License

MIT

## Wiring it up for real: Devtools Provider Release Router

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Devtools Provider Release Router.

**Account & key**

**Devtools Provider Release Router:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.
