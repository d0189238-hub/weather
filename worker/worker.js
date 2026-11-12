// 「曬衣服嗎」下雨通知登記處（Cloudflare Worker）
// 需要的設定：KV 綁定名稱 SUBS、Secret 名稱 API_TOKEN（跟 GitHub 的 PUSH_TOKEN 一樣）
// 只負責記名單；判斷天氣、發送通知由 GitHub 排程處理。

const ORIGINS = ["https://d0189238-hub.github.io"];
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_SUBS = 3000, MAX_PLACES = 8;

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha(s) { return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 22); }

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(req) } });

async function vapid(env) {
  let v = await env.SUBS.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), priv: (await crypto.subtle.exportKey("jwk", kp.privateKey)).d };
    await env.SUBS.put("vapid", JSON.stringify(v));
  }
  return v;
}
const all = async env => (await env.SUBS.get("all", "json")) || {};
const authed = (req, env) => env.API_TOKEN && req.headers.get("Authorization") === "Bearer " + env.API_TOKEN;

function cleanPlaces(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const p of list.slice(0, MAX_PLACES)) {
    if (!p || typeof p.c !== "string" || typeof p.t !== "string") continue;
    const c = p.c.slice(0, 8), t = p.t.slice(0, 8);
    if (/^[一-鿿]+$/.test(c) && /^[一-鿿]+$/.test(t)) out.push({ c, t });
  }
  return out.length ? out : null;
}
function cleanSub(s) {
  if (!s || typeof s.endpoint !== "string" || !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return null;
  let u; try { u = new URL(s.endpoint); } catch (e) { return null; }
  if (u.protocol !== "https:" || !PUSH_HOSTS.some(r => r.test(u.hostname)) || s.endpoint.length > 1000) return null;
  if (s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return null;
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (!env.SUBS) return json(req, { error: "還沒綁定 KV（變數名稱要叫 SUBS）" }, 500);

      if (path === "/" && req.method === "GET") return json(req, { ok: true, name: "曬衣服嗎 下雨通知登記處" });

      if (path === "/vapid" && req.method === "GET") return json(req, { pub: (await vapid(env)).pub });

      if (path === "/subscribe" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const sub = cleanSub(body && body.sub), places = cleanPlaces(body && body.places);
        if (!sub || !places) return json(req, { error: "資料格式不對" }, 400);
        const list = await all(env), id = await sha(sub.endpoint);
        if (!list[id] && Object.keys(list).length >= MAX_SUBS) return json(req, { error: "登記人數已滿" }, 503);
        list[id] = { sub, places, t: Date.now() };
        await env.SUBS.put("all", JSON.stringify(list));
        return json(req, { ok: true });
      }

      if (path === "/unsubscribe" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.endpoint !== "string") return json(req, { error: "資料格式不對" }, 400);
        const list = await all(env), id = await sha(body.endpoint);
        if (list[id]) { delete list[id]; await env.SUBS.put("all", JSON.stringify(list)); }
        return json(req, { ok: true });
      }

      if (path === "/list" && req.method === "GET") {
        if (!authed(req, env)) return json(req, { error: "沒有權限" }, 401);
        const list = await all(env);
        return json(req, { vapid: await vapid(env), subs: Object.entries(list).map(([id, v]) => ({ id, ...v })) });
      }

      if (path === "/prune" && req.method === "POST") {
        if (!authed(req, env)) return json(req, { error: "沒有權限" }, 401);
        const body = await req.json().catch(() => null), ids = body && Array.isArray(body.ids) ? body.ids : [];
        const list = await all(env); let n = 0;
        for (const id of ids) if (list[id]) { delete list[id]; n++; }
        if (n) await env.SUBS.put("all", JSON.stringify(list));
        return json(req, { ok: true, removed: n });
      }

      return json(req, { error: "找不到" }, 404);
    } catch (e) {
      return json(req, { error: "登記處出錯了" }, 500);
    }
  }
};
