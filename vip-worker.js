/**
 * VICE NEWS — Backend VIP (Cloudflare Worker)
 * --------------------------------------------------
 * Rotas:
 *   POST /auth/signup        -> { name, email, password } : cria conta + envia email verificação
 *   POST /auth/login         -> { email, password } : autentica
 *   GET  /auth/verify?token= -> verifica email e redireciona para o site
 *   GET  /auth/me?email=     -> devolve dados do utilizador (nome, vip, verified)
 *   POST /webhook            -> Stripe checkout.session.completed: gera código VIP + email
 *   POST /redeem             -> { code, email } : valida código VIP (uso único)
 *   GET  /health             -> status do worker
 */

const SITE = "https://vicenewsgta6.com";
const CORS = {
  "Access-Control-Allow-Origin": SITE,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/auth/signup"  && method === "POST") return handleSignup(request, env);
    if (path === "/auth/login"   && method === "POST") return handleLogin(request, env);
    if (path === "/auth/verify"  && method === "GET")  return handleVerify(url, env);
    if (path === "/auth/me"      && method === "GET")  return handleMe(url, env);
    if (path === "/redeem"       && method === "POST") return handleRedeem(request, env);
    if (path === "/webhook"      && method === "POST") return handleWebhook(request, env);
    if (path === "/health")                            return json({ ok: true, ts: Date.now() });

    return new Response("Vice News VIP backend", { status: 200, headers: CORS });
  },
};

/* ============================================================
   HELPERS
   ============================================================ */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function redirectToSite(query) {
  return Response.redirect(SITE + "/" + query, 302);
}

function genCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 10; i++) { s += c[Math.floor(Math.random() * c.length)]; if (i === 4) s += "-"; }
  return "VICE-" + s;
}

function genToken() {
  const arr = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   PASSWORD (PBKDF2)
   ============================================================ */
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
  return { hash, salt: saltHex };
}

async function checkPassword(password, storedHash, storedSalt) {
  const salt = new Uint8Array(storedSalt.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hash === storedHash;
}

/* ============================================================
   AUTH — SIGNUP
   ============================================================ */
async function handleSignup(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }

  const name  = (body.name  || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const pass  = body.password || "";

  if (!email || !pass)     return json({ ok: false, error: "missing_fields" });
  if (pass.length < 6)     return json({ ok: false, error: "password_too_short" });
  if (!/\S+@\S+\.\S+/.test(email)) return json({ ok: false, error: "invalid_email" });

  const existing = await env.VIP.get("user:" + email);
  if (existing) return json({ ok: false, error: "email_taken" });

  const { hash, salt } = await hashPassword(pass);
  const user = {
    name: name || email.split("@")[0],
    email,
    passHash: hash,
    salt,
    vip: false,
    verified: false,
    since: Date.now(),
  };
  await env.VIP.put("user:" + email, JSON.stringify(user));

  // Token de verificação (expira em 24h)
  const token = genToken();
  await env.VIP.put("verify:" + token, email, { expirationTtl: 86400 });

  await sendVerifyEmail(env, email, user.name, token);

  return json({ ok: true, needsVerify: true });
}

/* ============================================================
   AUTH — LOGIN
   ============================================================ */
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }

  const email = (body.email || "").trim().toLowerCase();
  const pass  = body.password || "";

  if (!email || !pass) return json({ ok: false, error: "missing_fields" });

  const raw = await env.VIP.get("user:" + email);
  if (!raw) return json({ ok: false, error: "invalid_credentials" });

  const user = JSON.parse(raw);
  const valid = await checkPassword(pass, user.passHash, user.salt);
  if (!valid) return json({ ok: false, error: "invalid_credentials" });

  return json({
    ok: true,
    user: { name: user.name, email: user.email, vip: user.vip, verified: user.verified },
  });
}

/* ============================================================
   AUTH — VERIFY EMAIL
   ============================================================ */
async function handleVerify(url, env) {
  const token = url.searchParams.get("token") || "";
  if (!token) return redirectToSite("?verified=error");

  const email = await env.VIP.get("verify:" + token);
  if (!email) return redirectToSite("?verified=expired");

  const raw = await env.VIP.get("user:" + email);
  if (raw) {
    const user = JSON.parse(raw);
    user.verified = true;
    await env.VIP.put("user:" + email, JSON.stringify(user));
  }

  await env.VIP.delete("verify:" + token);

  return redirectToSite("?verified=ok&email=" + encodeURIComponent(email));
}

/* ============================================================
   AUTH — ME (dados do utilizador)
   ============================================================ */
async function handleMe(url, env) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return json({ exists: false });

  const raw = await env.VIP.get("user:" + email);
  if (!raw) return json({ exists: false });

  const user = JSON.parse(raw);
  return json({ exists: true, name: user.name, email: user.email, vip: user.vip, verified: user.verified });
}

/* ============================================================
   REDEEM (código VIP)
   ============================================================ */
async function handleRedeem(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, reason: "bad_request" }, 400); }

  const code  = (body.code  || "").trim().toUpperCase();
  const email = (body.email || "").trim().toLowerCase();
  if (!code) return json({ ok: false, reason: "empty" });

  const raw = await env.VIP.get("code:" + code);
  if (!raw) return json({ ok: false, reason: "invalid" });

  const rec = JSON.parse(raw);
  if (rec.used) return json({ ok: false, reason: "used" });

  rec.used = true; rec.usedAt = Date.now(); rec.usedBy = email;
  await env.VIP.put("code:" + code, JSON.stringify(rec));

  // Marca VIP no registo do utilizador (se tiver conta)
  if (email) {
    await env.VIP.put("vip:" + email, "1");
    const userRaw = await env.VIP.get("user:" + email);
    if (userRaw) {
      const user = JSON.parse(userRaw);
      user.vip = true;
      await env.VIP.put("user:" + email, JSON.stringify(user));
    }
  }

  return json({ ok: true });
}

/* ============================================================
   WEBHOOK (Stripe)
   ============================================================ */
async function handleWebhook(request, env) {
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature") || "";
  const ok = await verifyStripe(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("bad signature", { status: 400 });

  let event;
  try { event = JSON.parse(payload); } catch { return new Response("bad json", { status: 400 }); }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object || {};
    const email = (session.customer_details && session.customer_details.email) || session.customer_email || "";

    let code = genCode();
    for (let i = 0; i < 5; i++) { if (!(await env.VIP.get("code:" + code))) break; code = genCode(); }
    await env.VIP.put("code:" + code, JSON.stringify({ used: false, email, ts: Date.now() }));

    // Marca VIP no user se tiver conta
    if (email) {
      await env.VIP.put("vip:" + email, "1");
      const userRaw = await env.VIP.get("user:" + email);
      if (userRaw) {
        const user = JSON.parse(userRaw);
        user.vip = true;
        await env.VIP.put("user:" + email, JSON.stringify(user));
      }
    }

    if (email) await sendVIPEmail(env, email, code);
  }
  return new Response("ok", { status: 200 });
}

/* ============================================================
   EMAIL — VERIFICAÇÃO DE CONTA
   ============================================================ */
async function sendVerifyEmail(env, to, name, token) {
  const verifyUrl = `https://vice-news-vip.clubpenguinvaidoso1999.workers.dev/auth/verify?token=${token}`;

  const html = `<!DOCTYPE html>
<html lang="pt">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#0d0221;border-radius:12px;overflow:hidden;max-width:560px;width:100%">
        <tr><td style="padding:28px 32px 0">
          <p style="margin:0;font-size:22px;font-weight:bold;color:#ff2d95">VICE NEWS</p>
          <p style="margin:4px 0 20px;font-size:16px;color:#00f0ff">Confirma o teu email</p>
        </td></tr>
        <tr><td style="padding:0 32px 24px">
          <p style="color:#f5e9ff;font-size:15px;line-height:1.5">Ola ${name}, obrigado por criares conta na Vice News GTA VI!</p>
          <p style="color:#f5e9ff;font-size:15px;line-height:1.5">Clica no botao abaixo para verificar o teu email e ativar a tua conta:</p>
          <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 0">
            <a href="${verifyUrl}" style="background:#ff2d95;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:bold;font-size:16px;display:inline-block">Verificar email</a>
          </td></tr></table>
          <p style="color:#7a6a90;font-size:13px;line-height:1.6">Se nao criaste conta, ignora este email. O link expira em 24 horas.<br>Ou copia este link: ${verifyUrl}</p>
        </td></tr>
        <tr><td style="background:#0a011a;padding:16px 32px;border-top:1px solid #1e0a40">
          <p style="margin:0;color:#7a6a90;font-size:12px">Vice News GTA VI — site de fas independente, nao afiliado com a Rockstar Games.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `VICE NEWS — Confirma o teu email\n\nOla ${name},\n\nClica no link abaixo para verificar o teu email:\n\n${verifyUrl}\n\nO link expira em 24 horas.\nSe nao criaste conta, ignora este email.`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "Vice News <onboarding@resend.dev>",
      to: [to],
      subject: "Verifica o teu email — Vice News GTA VI",
      html,
      text,
    }),
  });
}

/* ============================================================
   EMAIL — CÓDIGO VIP
   ============================================================ */
async function sendVIPEmail(env, to, code) {
  const html = `<!DOCTYPE html>
<html lang="pt">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#0d0221;border-radius:12px;overflow:hidden;max-width:560px;width:100%">
        <tr><td style="padding:28px 32px 0">
          <p style="margin:0;font-size:22px;font-weight:bold;color:#ff2d95">VICE NEWS</p>
          <p style="margin:4px 0 20px;font-size:16px;color:#00f0ff">O teu acesso VIP foi ativado</p>
        </td></tr>
        <tr><td style="padding:0 32px 24px">
          <p style="color:#f5e9ff;font-size:15px;line-height:1.5">Obrigado pela tua subscricao VIP. O teu codigo de ativacao exclusivo e:</p>
          <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0">
            <div style="font-size:26px;font-weight:bold;letter-spacing:3px;background:#190a32;border:2px solid #ffd700;color:#ffd700;padding:18px 24px;border-radius:10px;display:inline-block">${code}</div>
          </td></tr></table>
          <p style="color:#f5e9ff;font-size:15px;line-height:1.5;margin-top:20px">Para ativar o teu acesso:</p>
          <ol style="color:#f5e9ff;font-size:15px;line-height:2">
            <li>Acede a <a href="${SITE}" style="color:#ff2d95;text-decoration:none">${SITE.replace("https://","")}</a></li>
            <li>Clica em <strong>Conta</strong> e escolhe <strong>Ativar codigo VIP</strong></li>
            <li>Insere o codigo acima e clica em <strong>Ativar</strong></li>
          </ol>
          <p style="color:#f5e9ff;font-size:15px">O codigo e de uso unico e pessoal.</p>
        </td></tr>
        <tr><td style="background:#0a011a;padding:16px 32px;border-top:1px solid #1e0a40">
          <p style="margin:0;color:#7a6a90;font-size:12px;line-height:1.6">Vice News GTA VI e um site de fas independente, nao afiliado com a Rockstar Games ou a Take-Two Interactive. Se nao efetuaste esta compra, ignora este email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `VICE NEWS - O teu acesso VIP\n\nObrigado pela tua subscricao VIP!\n\nO teu codigo de ativacao e:\n\n${code}\n\nPara ativar:\n1. Acede a ${SITE}\n2. Clica em Conta > Ativar codigo VIP\n3. Insere o codigo e clica em Ativar\n\nO codigo e de uso unico e pessoal.\n\nVice News GTA VI - site de fas independente.`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "Vice News <onboarding@resend.dev>",
      to: [to],
      subject: "O teu codigo de acesso VIP - Vice News GTA VI",
      html,
      text,
    }),
  });
}

/* ============================================================
   STRIPE SIGNATURE VERIFICATION
   ============================================================ */
async function verifyStripe(payload, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const parts = {};
  sigHeader.split(",").forEach(p => { const [k, v] = p.split("="); parts[k] = v; });
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
