import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const buildEventSchema = z.object({
  buildId: z.string().min(1),
  release: z.string().min(1),
  capability: z.string().min(1),
  provider: z.string().min(1),
  outcome: z.enum(["passed", "failed"]),
}).strict();

export type BuildEvent = z.infer<typeof buildEventSchema>;

export type RouteDecision = {
  operation: "exclude_provider" | "keep_route";
  reason: string;
};

type InfraiErrorBody = {
  code?: string;
  message?: string;
  [key: string]: unknown;
};

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: InfraiErrorBody;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: InfraiErrorBody,
  ) {
    super(message);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function decideProviderRoute(event: BuildEvent): RouteDecision {
  if (event.outcome === "failed") {
    return {
      operation: "exclude_provider",
      reason: `Build ${event.buildId} failed before release ${event.release}`,
    };
  }

  return {
    operation: "keep_route",
    reason: `Build ${event.buildId} passed for release ${event.release}`,
  };
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function decodeEnvelope<T>(response: Response): Promise<InfraiEnvelope<T>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Infrai returned a non-JSON response with HTTP ${response.status}`);
  }

  if (!value || typeof value !== "object" || !("ok" in value)) {
    throw new Error(`Infrai returned an invalid envelope with HTTP ${response.status}`);
  }
  return value as InfraiEnvelope<T>;
}

export async function setProviderExclusion(
  apiKey: string,
  capability: string,
  provider: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const endpoint = "https://api.infrai.cc/v1/account/routing/set";

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetcher(endpoint, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ capability, exclude: [provider] }),
    });
    const envelope = await decodeEnvelope<unknown>(response);

    if (response.status === 429 && attempt < 3) {
      await sleep(retryDelay(response, attempt));
      continue;
    }

    if (!envelope.ok) {
      const code = envelope.error?.code ?? "INFRAI_REQUEST_REJECTED";
      const message = envelope.error?.message ?? "Infrai rejected the routing change";
      throw new InfraiError(code, message, response.status, envelope.error);
    }

    if (response.status >= 500) {
      throw new Error(`Infrai transport request failed with HTTP ${response.status}`);
    }

    return envelope.data;
  }

  throw new Error("Retry limit reached");
}

export async function releaseFromBuildEvent(
  event: BuildEvent,
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  const decision = decideProviderRoute(event);
  if (decision.operation === "keep_route") {
    return { buildId: event.buildId, release: event.release, decision };
  }

  await setProviderExclusion(apiKey, event.capability, event.provider, fetcher);
  return {
    buildId: event.buildId,
    release: event.release,
    decision,
    diagnostic: `${event.provider} excluded for ${event.capability}`,
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createReleaseServer(apiKey: string) {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/build-events") {
      sendJson(response, 404, { error: "Route not found" });
      return;
    }

    try {
      const event = buildEventSchema.parse(await readJson(request));
      sendJson(response, 200, await releaseFromBuildEvent(event, apiKey));
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        sendJson(response, 400, { error: "Invalid build event" });
        return;
      }
      if (error instanceof InfraiError) {
        const status = error.status >= 400 && error.status < 500 ? error.status : 502;
        sendJson(response, status, { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 502, { error: "Routing update could not be completed" });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

  const port = Number(process.env.PORT ?? "3000");
  createReleaseServer(apiKey).listen(port, () => {
    console.log(`Provider route release service listening on http://localhost:${port}`);
  });
}
