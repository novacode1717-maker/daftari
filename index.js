/*
 * Daftari - Cloudflare Workers + D1
 * File: index.js
 */

const SESSION_DAYS = 7;
const CODE_MINUTES = 10;
const RESET_MINUTES = 30;
const PASSWORD_ITERATIONS = 310000;

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Origin": request.headers.get("Origin") || url.origin,
          "Vary": "Origin"
        }
      });
    }

    try {
      if (!env.DB) {
        return json({ success: false, error: "قاعدة البيانات DB غير مربوطة." }, 500, request);
      }

      if (method === "GET" && path === "/api/health") {
        return json({ success: true, status: "ok", service: "daftari" }, 200, request);
      }

      if (method === "POST" && path === "/api/auth/register") return await register(request, env);
      if (method === "POST" && path === "/api/auth/verify-email") return await verifyEmail(request, env);
      if (method === "POST" && path === "/api/auth/resend-code") return await resendCode(request, env);
      if (method === "POST" && path === "/api/auth/login") return await login(request, env);
      if (method === "POST" && path === "/api/auth/logout") return await logout(request, env);
      if (method === "POST" && path === "/api/auth/forgot-password") return await forgotPassword(request, env);
      if (method === "POST" && path === "/api/auth/reset-password") return await resetPassword(request, env);

      if (method === "GET" && path === "/api/customers") {
        const session = await requireSession(request, env);
        if (session.error) return session.error;
        return await listCustomers(request, env, session.user);
      }

      if (method === "POST" && path === "/api/customers") {
        const session = await requireSession(request, env);
        if (session.error) return session.error;
        return await createCustomer(request, env, session.user);
      }

      const paymentMatch = path.match(/^\/api\/customers\/([^/]+)\/payments$/);
      if (method === "POST" && paymentMatch) {
        const session = await requireSession(request, env);
        if (session.error) return session.error;
        return await addPayment(request, env, session.user, paymentMatch[1]);
      }

      const customerMatch = path.match(/^\/api\/customers\/([^/]+)$/);
      if (method === "GET" && customerMatch) {
        const session = await requireSession(request, env);
        if (session.error) return session.error;
        return await getCustomerDetails(request, env, session.user, customerMatch[1]);
      }

      return json({ success: false, error: "المسار المطلوب غير موجود." }, 404, request);

    } catch (error) {
      console.error("Daftari Worker error:", error);
      return json({ success: false, error: "حدث خطأ داخلي في الخادم." }, 500, request);
    }
  }
};

// ==========================================
// COMMON HELPERS
// ==========================================

function json(data, status = 200, request = null, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  if (request) {
    const origin = request.headers.get("Origin");
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.set("Vary", "Origin");
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function cookieOptions(request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookieHeader(request) {
  return `daftari_session=; ${cookieOptions(request, 0)}`;
}

async function readBody(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: "صيغة البيانات غير صحيحة (يجب أن تكون JSON)." };
    }
    return body;
  } catch {
    return { error: "تعذر قراءة البيانات، تأكد من إرسال JSON صالح." };
  }
}

function cleanText(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return cleanText(value, 254).toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validAmount(value, allowZero = false) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function randomHex(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomCode() {
  const data = new Uint32Array(1);
  crypto.getRandomValues(data);
  return String(data[0] % 1000000).padStart(6, "0");
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password) {
  const salt = randomHex(16);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const saltBytes = new Uint8Array(salt.match(/.{2}/g).map(byte => parseInt(byte, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    key, 256
  );
  const hash = Array.from(new Uint8Array(bits)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
  try {
    if (typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iterations = Number(parts[1]);
    const salt = parts[2];
    const originalHash = parts[3];
    if (
      !Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000 ||
      !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(originalHash)
    ) return false;

    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new Uint8Array(salt.match(/.{2}/g).map(byte => parseInt(byte, 16))),
        iterations, hash: "SHA-256"
      },
      key, 256
    );
    const newHash = Array.from(new Uint8Array(bits)).map(byte => byte.toString(16).padStart(2, "0")).join("");
    return newHash === originalHash;
  } catch {
    return false;
  }
}

function expiration(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function isExpired(value) {
  return !value || Date.parse(value) <= Date.now();
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();
    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

// ==========================================
// EMAIL
// ==========================================

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    throw new Error("إعدادات البريد RESEND_API_KEY أو MAIL_FROM غير موجودة");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html })
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Resend error:", details);
    throw new Error("فشل إرسال البريد الإلكتروني");
  }
  return response.json();
}

function emailCodeHtml(code) {
  return `
    <div dir="rtl" style="font-family:Arial;text-align:center;padding:25px">
      <h2>مرحباً بك في دفتري</h2>
      <p>رمز تأكيد حسابك هو:</p>
      <h1 style="letter-spacing:8px">${code}</h1>
      <p>صلاحية الرمز ${CODE_MINUTES} دقائق.</p>
    </div>
  `;
}

async function createEmailCode(env, user) {
  const code = randomCode();
  const codeHash = await sha256(code);
  const expiresAt = expiration(CODE_MINUTES);
  await env.DB.prepare(`
    INSERT INTO email_codes (user_id, code_hash, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      code_hash = excluded.code_hash,
      expires_at = excluded.expires_at
  `).bind(user.id, codeHash, expiresAt).run();
  await sendEmail(env, user.email, "رمز تأكيد حساب دفتري", emailCodeHtml(code));
}

// ==========================================
// SESSIONS
// ==========================================

async function createSession(request, env, userId) {
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = expiration(SESSION_DAYS * 24 * 60);
  await env.DB.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(tokenHash, userId, expiresAt).run();

  return json(
    { success: true, message: "تم تسجيل الدخول بنجاح" },
    200, request,
    { "Set-Cookie": `daftari_session=${token}; ${cookieOptions(request, SESSION_DAYS * 24 * 60 * 60)}` }
  );
}

async function requireSession(request, env) {
  const token = getCookie(request, "daftari_session");
  if (!token) {
    return { error: json({ success: false, error: "يرجى تسجيل الدخول." }, 401, request) };
  }
  const tokenHash = await sha256(token);
  const result = await env.DB.prepare(`
    SELECT
      s.token_hash, s.expires_at, u.id, u.owner_name, u.father_name,
      u.shop_name, u.shop_address, u.email, u.email_verified
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first();

  if (!result) {
    return { error: json({ success: false, error: "الجلسة غير صالحة، يرجى تسجيل الدخول." }, 401, request) };
  }
  if (isExpired(result.expires_at)) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return { error: json({ success: false, error: "انتهت الجلسة، يرجى تسجيل الدخول مجدداً." }, 401, request) };
  }
  if (Number(result.email_verified) !== 1) {
    return { error: json({ success: false, error: "يرجى تأكيد البريد الإلكتروني أولاً." }, 403, request) };
  }
  return {
    user: {
      id: result.id, ownerName: result.owner_name, fatherName: result.father_name,
      shopName: result.shop_name, shopAddress: result.shop_address, email: result.email
    }
  };
}

// ==========================================
// AUTH - REGISTER
// ==========================================

async function register(request, env) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const ownerName = cleanText(body.ownerName, 100);
  const fatherName = cleanText(body.fatherName, 100);
  const shopName = cleanText(body.shopName, 150);
  const shopAddress = cleanText(body.shopAddress, 250);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!ownerName || !fatherName || !shopName || !shopAddress || !email || !password) {
    return json({ success: false, error: "يرجى ملء جميع الحقول المطلوبة." }, 400, request);
  }
  if (!validEmail(email)) {
    return json({ success: false, error: "البريد الإلكتروني غير صحيح." }, 400, request);
  }
  if (password.length < 6 || password.length > 128) {
    return json({ success: false, error: "كلمة المرور يجب أن تكون من 6 إلى 128 حرفاً." }, 400, request);
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
  if (existing) {
    return json({ success: false, error: "هذا البريد الإلكتروني مسجل مسبقاً." }, 409, request);
  }

  const userId = randomHex(16);
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(`
    INSERT INTO users (
      id, owner_name, father_name, shop_name, shop_address,
      email, password_hash, email_verified, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).bind(
    userId, ownerName, fatherName, shopName, shopAddress,
    email, passwordHash, new Date().toISOString()
  ).run();

  const user = { id: userId, email };
  try {
    await createEmailCode(env, user);
  } catch (error) {
    console.error("Registration email error:", error);
    return json({
      success: false,
      error: "تم إنشاء الحساب، لكن تعذر إرسال رمز التأكيد. حاول إعادة إرسال الرمز."
    }, 500, request);
  }

  return json({
    success: true,
    message: "تم إنشاء الحساب. أرسلنا رمز التأكيد إلى بريدك الإلكتروني.",
    userId
  }, 201, request);
}

// ==========================================
// AUTH - VERIFY EMAIL
// ==========================================

async function verifyEmail(request, env) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const email = normalizeEmail(body.email);
  const code = String(body.code || "").trim();

  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return json({ success: false, error: "البريد الإلكتروني أو رمز التأكيد غير صحيح." }, 400, request);
  }

  const user = await env.DB.prepare("SELECT id, email, email_verified FROM users WHERE email = ? LIMIT 1").bind(email).first();
  if (!user) {
    return json({ success: false, error: "الحساب غير موجود." }, 404, request);
  }
  if (Number(user.email_verified) === 1) {
    return json({ success: true, message: "البريد الإلكتروني مؤكد مسبقاً." }, 200, request);
  }

  const savedCode = await env.DB.prepare("SELECT code_hash, expires_at FROM email_codes WHERE user_id = ? LIMIT 1").bind(user.id).first();
  if (!savedCode || isExpired(savedCode.expires_at)) {
    return json({ success: false, error: "انتهت صلاحية الرمز. اطلب رمزاً جديداً." }, 400, request);
  }

  const submittedHash = await sha256(code);
  if (submittedHash !== savedCode.code_hash) {
    return json({ success: false, error: "رمز التأكيد غير صحيح." }, 400, request);
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM email_codes WHERE user_id = ?").bind(user.id)
  ]);

  return json({ success: true, message: "تم تأكيد البريد الإلكتروني بنجاح." }, 200, request);
}

// ==========================================
// AUTH - RESEND EMAIL CODE
// ==========================================

async function resendCode(request, env) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const email = normalizeEmail(body.email);
  if (!validEmail(email)) {
    return json({ success: false, error: "يرجى إدخال بريد إلكتروني صحيح." }, 400, request);
  }

  const user = await env.DB.prepare("SELECT id, email, email_verified FROM users WHERE email = ? LIMIT 1").bind(email).first();
  if (!user) {
    return json({ success: false, error: "الحساب غير موجود." }, 404, request);
  }
  if (Number(user.email_verified) === 1) {
    return json({ success: true, message: "البريد الإلكتروني مؤكد مسبقاً." }, 200, request);
  }

  try {
    await createEmailCode(env, user);
  } catch (error) {
    console.error("Resend code error:", error);
    return json({ success: false, error: "تعذر إرسال رمز التأكيد. حاول مرة أخرى." }, 500, request);
  }

  return json({ success: true, message: "تم إرسال رمز تأكيد جديد إلى بريدك الإلكتروني." }, 200, request);
}

// ==========================================
// AUTH - LOGIN
// ==========================================

async function login(request, env) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!validEmail(email) || !password) {
    return json({ success: false, error: "يرجى إدخال البريد الإلكتروني وكلمة المرور." }, 400, request);
  }

  const user = await env.DB.prepare(`
    SELECT id, owner_name, father_name, shop_name, shop_address, email, password_hash, email_verified
    FROM users WHERE email = ? LIMIT 1
  `).bind(email).first();

  if (!user) {
    return json({ success: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة." }, 401, request);
  }

  const passwordValid = await verifyPassword(password, user.password_hash);
  if (!passwordValid) {
    return json({ success: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة." }, 401, request);
  }

  if (Number(user.email_verified) !== 1) {
    return json({
      success: false,
      error: "يرجى تأكيد البريد الإلكتروني قبل تسجيل الدخول.",
      needsVerification: true
    }, 403, request);
  }

  return await createSession(request, env, user.id);
}

// ==========================================
// AUTH - LOGOUT
// ==========================================

async function logout(request, env) {
  const token = getCookie(request, "daftari_session");
  if (token) {
    const tokenHash = await sha256(token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  
  return json(
    { success: true, message: "تم تسجيل الخروج بنجاح." }, 
    200, 
    request, 
    { "Set-Cookie": clearCookieHeader(request) }
  );
}

// ==========================================
// PASSWORD RESET - FORGOT PASSWORD
// ==========================================

async function forgotPassword(request, env) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const email = normalizeEmail(body.email);
  if (!validEmail(email)) {
    return json({ success: false, error: "يرجى إدخال بريد إلكتروني صحيح." }, 400, request);
  }

  const genericMessage = "إذا كان البريد مسجلاً لدينا، فستصلك رسالة تحتوي على رابط استعادة كلمة المرور.";
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ? LIMIT 1").bind(email).first();

  if (!user) {
    return json({ success: true, message: genericMessage }, 200, request);
  }

  if (!env.APP_BASE_URL) {
    console.error("APP_BASE_URL is missing");
    return json({ success: false, error: "إعداد رابط الموقع APP_BASE_URL غير موجود." }, 500, request);
  }

  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = expiration(RESET_MINUTES);

  await env.DB.prepare(`
    INSERT INTO reset_tokens (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(tokenHash, user.id, expiresAt).run();

  const baseUrl = env.APP_BASE_URL.replace(/\/+$/, "");
  const resetUrl = `${baseUrl}/?reset=${encodeURIComponent(token)}`;

  const html = `
    <div dir="rtl" style="font-family:Arial;text-align:center;padding:25px">
      <h2>استعادة كلمة مرور دفتري</h2>
      <p>وصلنا طلباً لإعادة تعيين كلمة المرور.</p>
      <p>اضغط على الرابط التالي لإعادة تعيين كلمة المرور:</p>
      <a href="${resetUrl}" style="display:inline-block;padding:12px 25px;background:#d4af37;color:#000;text-decoration:none;border-radius:8px">
        إعادة تعيين كلمة المرور
      </a>
      <p>صلاحية الرابط ${RESET_MINUTES} دقيقة.</p>
      <p>إذا لم تطلب استعادة كلمة المرور، يمكنك تجاهل هذه الرسالة.</p>
    </div>
  `;

  try {
    await sendEmail(env, user.email, "استعادة كلمة مرور دفتري", html);
  } catch (error) {
    console.error("Password reset email error:", error);
    return json({ success: false, error: "تعذر إرسال رسالة الاستعادة. حاول مرة أخرى." }, 500, request);
  }

  return json({ success: true, message: genericMessage }, 200, request);
}

// ==========================================
// PASSWORD RESET - RESET PASSWORD
// ==========================================

async function resetPassword(request, env) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const token = String(body.token || "").trim();
  const password = String(body.password || "");

  if (!token) {
    return json({ success: false, error: "رابط الاستعادة غير صالح." }, 400, request);
  }
  if (password.length < 6 || password.length > 128) {
    return json({ success: false, error: "كلمة المرور يجب أن تكون من 6 إلى 128 حرفاً." }, 400, request);
  }

  const tokenHash = await sha256(token);
  const savedToken = await env.DB.prepare("SELECT token_hash, user_id, expires_at FROM reset_tokens WHERE token_hash = ? LIMIT 1").bind(tokenHash).first();

  if (!savedToken || isExpired(savedToken.expires_at)) {
    return json({ success: false, error: "انتهت صلاحية رابط الاستعادة أو أنه غير صالح." }, 400, request);
  }

  const passwordHash = await hashPassword(password);

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, savedToken.user_id),
    env.DB.prepare("DELETE FROM reset_tokens WHERE user_id = ?").bind(savedToken.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(savedToken.user_id)
  ]);

  return json({ success: true, message: "تم تغيير كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن." }, 200, request);
}

// ==========================================
// CUSTOMERS - CREATE CUSTOMER
// ==========================================

async function createCustomer(request, env, user) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const name = cleanText(body.name, 150);
  const phone = cleanText(body.phone, 30);
  const address = cleanText(body.address, 250);
  const purchaseName = cleanText(body.purchaseName, 200);

  const total = Number(body.total);
  const paid = Number(body.paid ?? 0);
  const monthly = Number(body.monthly ?? 0);

  if (!name || !purchaseName) {
    return json({ success: false, error: "يرجى إدخال اسم الزبون واسم المادة." }, 400, request);
  }
  
  if (!validAmount(total) || !validAmount(paid, true) || !validAmount(monthly, true) || total <= 0 || paid > total) {
    return json({ success: false, error: "المبالغ المدخلة غير صحيحة." }, 400, request);
  }

  const customerId = randomHex(16);
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(`
      INSERT INTO customers (
        id, user_id, name, phone, address, purchase_name, total, paid, monthly, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(customerId, user.id, name, phone, address, purchaseName, total, paid, monthly, now),

    env.DB.prepare(`
      INSERT INTO payment_history (
        id, customer_id, user_id, description, amount, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(randomHex(16), customerId, user.id, "قيمة الشراء", total, now)
  ];

  if (paid > 0) {
    statements.push(
      env.DB.prepare(`
        INSERT INTO payment_history (
          id, customer_id, user_id, description, amount, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(randomHex(16), customerId, user.id, "الدفعة الأولى", -paid, now)
    );
  }

  await env.DB.batch(statements);

  return json({ success: true, message: "تمت إضافة الزبون بنجاح.", customerId }, 201, request);
}

// ==========================================
// CUSTOMERS - LIST CUSTOMERS
// ==========================================

async function listCustomers(request, env, user) {
  const result = await env.DB.prepare(`
    SELECT id, name, phone, address, purchase_name, total, paid, monthly, created_at
    FROM customers WHERE user_id = ? ORDER BY created_at DESC
  `).bind(user.id).all();

  const customers = (result.results || []).map((customer) => ({
    ...customer,
    remaining: Number(customer.total) - Number(customer.paid)
  }));

  return json({ success: true, customers }, 200, request);
}

// ==========================================
// CUSTOMERS - GET CUSTOMER DETAILS
// ==========================================

async function getCustomerDetails(request, env, user, customerId) {
  const customer = await env.DB.prepare(`
    SELECT id, name, phone, address, purchase_name, total, paid, monthly, created_at
    FROM customers WHERE id = ? AND user_id = ? LIMIT 1
  `).bind(customerId, user.id).first();

  if (!customer) {
    return json({ success: false, error: "الزبون غير موجود." }, 404, request);
  }

  const historyResult = await env.DB.prepare(`
    SELECT id, description, amount, created_at
    FROM payment_history WHERE customer_id = ? AND user_id = ? ORDER BY created_at DESC
  `).bind(customerId, user.id).all();

  const history = historyResult.results || [];
  const customerDetails = { ...customer, remaining: Number(customer.total) - Number(customer.paid) };

  return json({ success: true, customer: customerDetails, history, payments: history }, 200, request);
}

// ==========================================
// CUSTOMERS - ADD PAYMENT
// ==========================================

async function addPayment(request, env, user, customerId) {
  const body = await readBody(request);
  if (body.error) return json({ success: false, error: body.error }, 400, request);

  const amount = Number(body.amount);
  const description = cleanText(body.description, 200) || "دفعة جديدة";

  if (!validAmount(amount) || amount <= 0) {
    return json({ success: false, error: "مبلغ الدفعة غير صحيح." }, 400, request);
  }

  const customer = await env.DB.prepare("SELECT id, total, paid FROM customers WHERE id = ? AND user_id = ? LIMIT 1").bind(customerId, user.id).first();
  if (!customer) {
    return json({ success: false, error: "الزبون غير موجود." }, 404, request);
  }

  const total = Number(customer.total);
  const currentPaid = Number(customer.paid);
  const remaining = total - currentPaid;

  if (amount > remaining) {
    return json({ success: false, error: "مبلغ الدفعة أكبر من المبلغ المتبقي." }, 400, request);
  }

  const newPaid = currentPaid + amount;
  const now = new Date().toISOString();

  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE customers SET paid = ? WHERE id = ? AND user_id = ? AND paid = ?
    `).bind(newPaid, customerId, user.id, currentPaid),

    env.DB.prepare(`
      INSERT INTO payment_history (id, customer_id, user_id, description, amount, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM customers WHERE id = ? AND user_id = ? AND paid = ?
      )
    `).bind(randomHex(16), customerId, user.id, description, -amount, now, customerId, user.id, newPaid)
  ]);

  if (
    !results[0].meta || results[0].meta.changes !== 1 ||
    !results[1].meta || results[1].meta.changes !== 1
  ) {
    return json({ success: false, error: "تعذر تسجيل الدفعة. حدّث الصفحة وحاول مرة أخرى." }, 409, request);
  }

  return json({ success: true, message: "تم تسجيل الدفعة بنجاح.", paid: newPaid, remaining: total - newPaid }, 200, request);
}
