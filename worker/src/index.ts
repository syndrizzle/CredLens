// Model proxy for the CredLens backend (D-09). It holds no data and runs one chat completion per request;
// retrieval, guardrails and citation checks stay in FastAPI.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS = 30_000;

type AnswerRequest = { system: string; user: string };

function isAnswerRequest(value: unknown): value is AnswerRequest {
  if (!value || typeof value !== "object") return false;
  const { system, user } = value as Record<string, unknown>;
  return [system, user].every(
    (part) => typeof part === "string" && part.trim().length > 0 && part.length <= MAX_PROMPT_CHARS,
  );
}

async function authorised(header: string | null, token: string | undefined) {
  if (!token || !header) return false;
  const encoder = new TextEncoder();
  // Hash both sides so the comparison is constant-time and length-independent.
  const [a, b] = await Promise.all(
    [header, `Bearer ${token}`].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

function contentOf(result: unknown): string | null {
  const choice = (result as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0];
  const content = choice?.message?.content ?? (result as { response?: unknown })?.response;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/v1/answer") return Response.json({ error: "not_found" }, { status: 404 });
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    if (!(await authorised(request.headers.get("authorization"), env.CREDLENS_AI_TOKEN))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return Response.json({ error: "too_large" }, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!isAnswerRequest(body)) return Response.json({ error: "invalid_request" }, { status: 400 });

    try {
      const result = await env.AI.run(env.MODEL, {
        messages: [
          { role: "system", content: body.system },
          { role: "user", content: body.user },
        ],
        max_completion_tokens: 1024,
        temperature: 0,
        seed: 42,
        chat_template_kwargs: { enable_thinking: false },
      });
      const content = contentOf(result);
      if (!content) return Response.json({ error: "empty_answer" }, { status: 502 });
      return Response.json({ model: env.MODEL, content });
    } catch {
      // Never echo upstream errors: they can quote the prompt.
      return Response.json({ error: "model_unavailable" }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
