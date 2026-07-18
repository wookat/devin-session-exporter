const ALLOWED_ORIGIN = "https://app.devin.ai";
const DEFAULT_TTL_SECONDS = 86400;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const SHARE_ID_BYTES = 16;

function corsHeaders(origin) {
  if (origin !== ALLOWED_ORIGIN) return {};
  return {
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}

function textResponse(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers
    }
  });
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

function isAllowedMutationOrigin(origin) {
  return !origin || origin === ALLOWED_ORIGIN;
}

function shareTtlSeconds(env) {
  const configured = Number(env.SHARE_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TTL_SECONDS;
  return Math.max(60, Math.floor(configured));
}

function createShareId() {
  const bytes = new Uint8Array(SHARE_ID_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validShareId(id) {
  return /^[a-f0-9]{32}$/i.test(id);
}

async function createShare(request, env, origin) {
  if (!isAllowedMutationOrigin(origin)) {
    return textResponse("Origin not allowed", 403, corsHeaders(origin));
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_BYTES) {
    return jsonResponse({ error: "content too large" }, 413, origin);
  }
  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_CONTENT_BYTES) {
      return jsonResponse({ error: "content too large" }, 413, origin);
    }
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "invalid JSON" }, 400, origin);
  }
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return jsonResponse({ error: "content is required" }, 400, origin);
  }
  const title = typeof body.title === "string" ? body.title.slice(0, 300) : "Devin session";
  const ttl = shareTtlSeconds(env);
  let id = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = createShareId();
    if (!(await env.SHARES.get(candidate))) {
      id = candidate;
      break;
    }
  }
  if (!id) return jsonResponse({ error: "could not allocate share id" }, 503, origin);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  await env.SHARES.put(id, JSON.stringify({
    content: body.content,
    title,
    createdAt
  }), { expirationTtl: ttl });
  return jsonResponse({
    url: `${new URL(request.url).origin}/s/${id}`,
    id,
    expiresAt
  }, 201, origin);
}

async function readShare(id, env) {
  if (!validShareId(id)) return textResponse("Not found", 404);
  const stored = await env.SHARES.get(id, "json");
  if (!stored || typeof stored.content !== "string") {
    return textResponse("Not found", 404);
  }
  return new Response(stored.content, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function deleteShare(id, request, env, origin) {
  if (!isAllowedMutationOrigin(origin)) {
    return textResponse("Origin not allowed", 403, corsHeaders(origin));
  }
  if (!validShareId(id)) return textResponse("Not found", 404, corsHeaders(origin));
  await env.SHARES.delete(id);
  return jsonResponse({ ok: true }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (!isAllowedMutationOrigin(origin)) return textResponse("Origin not allowed", 403);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/share" && request.method === "POST") {
      return createShare(request, env, origin);
    }
    const match = url.pathname.match(/^\/s\/([^/]+)$/);
    if (match && request.method === "GET") {
      return readShare(match[1], env);
    }
    if (match && request.method === "DELETE") {
      return deleteShare(match[1], request, env, origin);
    }
    return textResponse("Not found", 404);
  }
};
