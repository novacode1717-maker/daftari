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
          "Access-Control-Allow-Origin": url.origin
        }
      });
    }

    try {
      if (!env.DB) {
        return json({
          error: "قاعدة البيانات DB غير مربوطة."
        }, 500, request);
      }

      if (method === "GET" && path === "/api/health") {
        return json({
          status: "ok",
          service: "daftari"
        }, 200, request);
      }

      // Authentication
      if (method === "POST" && path === "/api/auth/register") {
        return await register(request, env);
      }

      if (method === "POST" && path === "/api/auth/verify-email") {
        return await verifyEmail(request, env);
      }

      if (method === "POST" && path === "/api/auth/resend-code") {
        return await resendCode(request, env);
      }

      if (method === "POST" && path === "/api/auth/login") {
        return await login(request, env);
      }

      if (method === "POST" && path === "/api/auth/logout") {
        return await logout(request, env);
      }

      if (method === "POST" && path === "/api/auth/forgot-password") {
        return await forgotPassword(request, env);
      }

      if (method === "POST" && path === "/api/auth/reset-password") {
        return await resetPassword(request, env);
      }

      // Customer list
      if (method === "GET" && path === "/api/customers") {
        const session = await requireSession(request, env);

        if (session.error) return session.error;

        const result = await env.DB.prepare(
          `SELECT
            id,
            name,
            phone,
            address,
            purchase_name AS purchaseName,
            total,
            paid,
            monthly,
            (total - paid) AS remaining,
            created_at AS createdAt
          FROM customers
          WHERE user_id = ?
          ORDER BY created_at DESC`
        ).bind(session.user.id).all();

        return json({
          customers: result.results || []
        }, 200, request);
      }

      // Add customer
      if (method === "POST" && path === "/api/customers") {
        const session = await requireSession(request, env);

        if (session.error) return session.error;

        return await createCustomer(
          request,
          env,
          session.user
        );
      }

      // Customer details
      const customerMatch = path.match(
        /^\/api\/customers\/([^/]+)$/
      );

      if (method === "GET" && customerMatch) {
        const session = await requireSession(request, env);

        if (session.error) return session.error;
return await getCustomerDetails(request, env, session.user, customerMatch[1]);


      }

      // Customer payment
      const paymentMatch = path.match(
        /^\/api\/customers\/([^/]+)\/payments$/
      );
      if (method === "POST" && paymentMatch) {
        const session = await requireSession(request, env);

        if (session.error) return session.error;

        return await addPayment(
          request,
          env,
          session.user,
          paymentMatch[1]
        );
      }

      return json({
        error: "المسار المطلوب غير موجود."
      }, 404, request);

    } catch (error) {
      console.error("Daftari Worker error:", error);

      return json({
        error: "حدث خطأ داخلي في الخادم."
      }, 500, request);
    }
  }
};
// ==========================================
// PART 2: HELPER FUNCTIONS & SECURITY
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

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function cookieOptions(request, maxAge) {
  const secure = new URL(request.url).protocol === "https:"
    ? "; Secure"
    : "";

  return `HttpOnly; Path=/; SameSite=Lax;Max-Age=${maxAge}${secure}`;
}

function clearCookie(request) {
  return json(
    { success: true, message: "تم تسجيل الخروج" },
    200,
    request,
    {
      "Set-Cookie": `daftari_session=; ${cookieOptions(request, 0)}`
    }
  );
}

async function readBody(request) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" ||
      Array.isArray(body)) {
      return null;
    }

    return body;
  } catch {
    return null;
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
  return Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0);
}

function randomHex(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomCode() {
  const data = new Uint32Array(1);
  crypto.getRandomValues(data);

  return String(data[0] % 1000000).padStart(6, "0");
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password) {
  const salt = randomHex(16);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new Uint8Array(
        salt.match(/.{2}/g).map(byte => parseInt(byte, 16))
      ),
      iterations: PASSWORD_ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );

  const hash = Array.from(new Uint8Array(bits))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
  try {
    const parts = stored.split("$");

    if (parts.length !== 4 || parts[0] !==  "pbkdf2") {
      return false;
    }

    const iterations = Number(parts[1]);
    const salt = parts[2];
    const originalHash = parts[3];

    if (
  !Number.isInteger(iterations) ||
  iterations < 100000 ||
  iterations > 1000000 ||
  !/^[a-f0-9]{32}$/.test(salt) ||
  !/^[a-f0-9]{64}$/.test(originalHash)
) {
  return false;
}

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new Uint8Array(
          salt.match(/.{2}/g).map(byte => parseInt(byte, 16))
        ),
        iterations,
        hash: "SHA-256"
      },
      key,
      256
    );

    const newHash = Array.from(new Uint8Array(bits))
    
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    return newHash === originalHash;
  } catch {
    return false;
  }
}

function expiration(minutes) {
  return new Date(
    Date.now() + minutes * 60 * 1000
  ).toISOString();
}

function isExpired(value) {
  return !value || Date.parse(value) <= Date.now();
}
// إرسال البريد الإلكتروني عبر Resend
async function sendEmail(env, to, subject, html) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject,
      html
    })
  });

  if (!response.ok) {
    throw new Error("فشل إرسال البريد الإلكتروني");
  }

  return await response.json();
}

// تصميم رسالة رمز التأكيد
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

// إنشاء رمز التأكيد وإرساله
async function createEmailCode(env, user) {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);

  const code = String(random[0] % 1000000).padStart(6, "0");
  const codeHash = await sha256(code);
  const expiresAt = new Date(
    Date.now() + CODE_MINUTES * 60 * 1000
  ).toISOString();

  await env.DB.prepare(`
    INSERT INTO email_codes (
      user_id,
      code_hash,
      expires_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      code_hash = excluded.code_hash,
      expires_at = excluded.expires_at
  `).bind(
    user.id,
    codeHash,
    expiresAt
  ).run();

  await sendEmail(
    env,
    user.email,
    "رمز تأكيد حساب دفتري",
    emailCodeHtml(code)
  );
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");

    if (separator === -1) continue;

    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}
// ==========================================
// PART 3: AUTHENTICATION & USER SESSIONS
// ==========================================

// إنشاء جلسة تسجيل دخول
async function createSession(request, env, userId) {
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = expiration(SESSION_DAYS * 24 * 60);

  await env.DB.prepare(`
    INSERT INTO sessions (
      token_hash,
      user_id,
      expires_at
    ) VALUES (?, ?, ?)
  `).bind(
    tokenHash,
    userId,
    expiresAt
  ).run();

  return json(
    {
      success: true,
      message: "تم تسجيل الدخول بنجاح"
    },
    200,
    request,
    {
      "Set-Cookie": `daftari_session=${token}; ${cookieOptions(
        request,
        SESSION_DAYS * 24 * 60 * 60
      )}`
    }
  );
}

// التحقق من جلسة المستخدم
async function requireSession(request, env) {
  const token = getCookie(request, "daftari_session");

if (!token) {
  return {
    error: json({ error: "يرجى تسجيل الدخول." }, 401, request)
  };
}

  const tokenHash = await sha256(token);

  const result = await env.DB.prepare(
  `SELECT
      s.token_hash,
      s.expires_at,
      u.id,
      u.owner_name,
      u.father_name,
      u.shop_name,
      u.shop_address,
      u.email,
      u.email_verified
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
    LIMIT 1`
  ).bind(tokenHash).first();
if (!result) {
  return {
    error: json({ error: "الجلسة غير صالحة، يرجى تسجيل الدخول." }, 401, request)
  };
}

  if (isExpired(result.expires_at)) {
    await env.DB.prepare(
      "DELETE FROM sessions WHERE token_hash = ?"
    ).bind(tokenHash).run();

    return {
  error: json({ error: "انتهت الجلسة، يرجى تسجيل الدخول مجدداً." }, 401, request)
};
  }

 if (result.email_verified !== 1) {
  return {
    error: json(
      { error: "يرجى تأكيد البريد الإلكتروني أولاً." },
      403,
      request
    )
  };
}
 return {
  user: {
    id: result.id,
    ownerName: result.owner_name,
    fatherName: result.father_name,
    shopName: result.shop_name,
    shopAddress: result.shop_address,
    email: result.email
  }
};
}
// ==========================================
// REGISTER
// ==========================================

async function register(request, env) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const ownerName = cleanText(body.ownerName, 100);
  const fatherName = cleanText(body.fatherName, 100);
  const shopName = cleanText(body.shopName, 150);
  const shopAddress = cleanText(body.shopAddress, 250);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string"
    ? body.password
    : "";

  if (
    !ownerName ||
    !fatherName ||
    !shopName ||
    !shopAddress ||
    !email ||
    !password
  ) {
    return json(
      { success: false, message: "يرجى ملء جميع الحقول" },
      400,
      request
    );
  }

  if (!validEmail(email)) {
    return json(
      { success: false, message: "البريد الإلكتروني غير صحيح" },
      400,
      request
    );
  }

  if (password.length < 6 || password.length > 128) {
    return json(
      { success: false, message: "كلمة المرور يجب أن تكون بين 6 و128 حرفاً" },
      400,
      request
    );
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? LIMIT 1"
  ).bind(email).first();

  if (existing) {
    return json(
      { success: false, message: "هذا البريد مسجل مسبقاً" },
      409,
      request
    );
  }

  const user = {
    id: randomHex(16),
    owner_name: ownerName,
    father_name: fatherName,
    shop_name: shopName,
    shop_address: shopAddress,
    email,
    password_hash: await hashPassword(password),
    email_verified: 0,
    created_at: new Date().toISOString()
  };

  await env.DB.prepare(`
    INSERT INTO users (
      id,
      owner_name,
      father_name,
      shop_name,
      shop_address,
      email,
      password_hash,
      email_verified,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id,
    user.owner_name,
    user.father_name,
    user.shop_name,
    user.shop_address,
    user.email,
    user.password_hash,
    user.email_verified,
    user.created_at
  ).run();

  try {
    await createEmailCode(env, user);
    } catch (error) {
    await env.DB.prepare(
      "DELETE FROM users WHERE id = ?"
    ).bind(user.id).run();

    throw error;
  }

  return json(
    {
      success: true,
      message: "تم إنشاء الحساب. تحقق من بريدك الإلكتروني لإكمال التسجيل."
    },
    201,
    request
  );
}

// ==========================================
// VERIFY EMAIL
// ==========================================

async function verifyEmail(request, env) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const email = normalizeEmail(body.email);
  const code = cleanText(body.code, 6);

  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return json(
      { success: false, message: "البريد أو رمز التأكيد غير صحيح" },
      400,
      request
    );
  }

  const user = await env.DB.prepare(`
    SELECT id, email_verified FROM users
    WHERE email = ?
    LIMIT 1
  `).bind(email).first();

  if (!user) {
    return json(
      { success: false, message: "بيانات التأكيد غير صحيحة" },
      400,
      request
    );
  }

  if (user.email_verified === 1) {
    return json(
      { success: true, message: "البريد الإلكتروني مؤكد مسبقاً" },
      200,
      request
    );
  }

  const savedCode = await env.DB.prepare(`
    SELECT code_hash, expires_at FROM email_codes
    WHERE user_id = ?
    LIMIT 1
  `).bind(user.id).first();

  if (!savedCode || isExpired(savedCode.expires_at)) {
    return json(
      { success: false, message: "انتهت صلاحية الرمز. اطلب رمزاً جديداً." },
      400,
      request
    );
  }
  
  const submittedHash = await sha256(code);

  if (submittedHash !== savedCode.code_hash) {
    return json(
      { success: false, message: "رمز التأكيد غير صحيح" },
      400,
      request
    );
  }

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET email_verified = 1 WHERE id = ?"
    ).bind(user.id),

    env.DB.prepare(
      "DELETE FROM email_codes WHERE user_id = ?"
    ).bind(user.id)
  ]);

  return json(
    { success: true, message: "تم تأكيد البريد الإلكتروني بنجاح" },
    200,
    request
  );
}

// ==========================================
// RESEND EMAIL CODE
// ==========================================

async function resendCode(request, env) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const email = normalizeEmail(body.email);

  if (!validEmail(email)) {
    return json(
      { success: false, message: "البريد الإلكتروني غير صحيح" },
      400,
      request
    );
  }

  const user = await env.DB.prepare(`
    SELECT id, email, email_verified
    FROM users
    WHERE email = ?
    LIMIT 1
  ).bind(email).first();

  if (!user  user.email_verified === 1) {
    return json(
      { success: true, message: "إذا كان الحساب يحتاج تأكيداً فسيتم إرسال الرمز." },
      200,
      request
    );
  }

  await createEmailCode(env, user);

  return json(
    { success: true, message: "تم إرسال رمز جديد إلى بريدك الإلكتروني" },
    200,
    request
  );
}

// ==========================================
// LOGIN
// ==========================================

async function login(request, env) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string"
    ? body.password
    : "";

  if (!validEmail(email) || !password) {
    return json(
      { success: false, message: "يرجى إدخال البريد وكلمة المرور" },
      400,
      request
    );
  }

  const user = await env.DB.prepare(`
    SELECT
      id,
      owner_name,
      father_name,
      shop_name,
      shop_address,
      email,
      password_hash,
      email_verified
    FROM users
    WHERE email = ?
    LIMIT 1
  `).bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json(
      { success: false, message: "البريد أو كلمة المرور غير صحيحة" },
      401,
      request
    );
  }

  if (user.email_verified !== 1) {
    return json(
      {
        success: false,
        message: "يرجى تأكيد بريدك الإلكتروني أولاً",
        needsVerification: true
      },
      403,
      request
    );
  }

  const sessionResponse = await createSession(
    request,
    env,
    user.id
  );

  const headers = new Headers(sessionResponse.headers);

  return new Response(
    JSON.stringify({
      success: true,
      message: "تم تسجيل الدخول بنجاح",
      user: {
        id: user.id,
        ownerName: user.owner_name,
        fatherName: user.father_name,
        shopName: user.shop_name,
        shopAddress: user.shop_address,
        email: user.email
      }
    }),
    {
      status: 200,
      headers
    }
  );
}

// ==========================================
// LOGOUT
// ==========================================

async function logout(request, env) {
  const token = getCookie(request, "daftari_session");

  if (token) {
    const tokenHash = await sha256(token);

    await env.DB.prepare(
      "DELETE FROM sessions WHERE token_hash = ?"
    ).bind(tokenHash).run();
  }

  return clearCookie(request);
}

// ==========================================
// FORGOT PASSWORD
// ==========================================

async function forgotPassword(request, env) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const email = normalizeEmail(body.email);

  if (!validEmail(email)) {
    return json(
      { success: false, message: "البريد الإلكتروني غير صحيح" },
      400,
      request
    );
  }

  const genericMessage = {
    success: true,
    message: "إذا كان البريد مسجلاً ومؤكداً فستصلك رسالة استعادة كلمة المرور."
  };

  const user = await env.DB.prepare(
    SELECT id, email
    FROM users
    WHERE email = ?
      AND email_verified = 1
    LIMIT 1
  ).bind(email).first();

  if (!user) {
    return json(genericMessage, 200, request);
  }

  if (!env.APP_BASE_URL) {
    throw new Error("إعداد APP_BASE_URL غير موجود");
  }

  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = expiration(RESET_MINUTES);

  await env.DB.prepare(
    "DELETE FROM reset_tokens WHERE user_id = ?"
  ).bind(user.id).run();

  await env.DB.prepare(
    INSERT INTO reset_tokens (
      token_hash,
      user_id,
      expires_at
    ) VALUES (?, ?, ?)
  ).bind(
    tokenHash,
    user.id,
    expiresAt
  ).run();

  const baseUrl = env.APP_BASE_URL.replace(/\/+$/, "");
  const resetUrl = ${baseUrl}/?token=${encodeURIComponent(token)};

  const html = 
    <div dir="rtl" style="font-family:Arial;text-align:center;padding:30px">
      <h2>دفتري - استعادة كلمة المرور</h2>
      <p>اضغط على الرابط التالي لتغيير كلمة المرور:</p>
      <p>
        <a href="${resetUrl}"
           style="display:inline-block;padding:12px 25px;background:#d4af37;color:#000;text-decoration:none;border-radius:8px">
          تغيير كلمة المرور
        </a>
      </p>
      <p>صلاحية الرابط 30 دقيقة فقط.</p>
      <p>إذا لم تطلب الاستعادة، تجاهل هذه الرسالة.</p>
    </div>
  ;

  await sendEmail(
    env,
    user.email,
    "استعادة كلمة مرور دفتري",
    html
  );

  return json(genericMessage, 200, request);
}

// ==========================================
// RESET PASSWORD
// ==========================================

async function resetPassword(request, env) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const token = cleanText(body.token, 200);
  const password = typeof body.password === "string"
    ? body.password
    : "";
  if (!token  password.length < 6  password.length > 128) {
    return json(
      { success: false, message: "الرابط أو كلمة المرور غير صحيح" },
      400,
      request
    );
  }

  const tokenHash = await sha256(token);

  const savedToken = await env.DB.prepare(
    SELECT token_hash, user_id, expires_at
    FROM reset_tokens
    WHERE token_hash = ?
    LIMIT 1
  ).bind(tokenHash).first();

  if (!savedToken || isExpired(savedToken.expires_at)) {
    return json(
      { success: false, message: "انتهت صلاحية رابط الاستعادة أو أنه غير صالح" },
      400,
      request
    );
  }

  const passwordHash = await hashPassword(password);

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET password_hash = ? WHERE id = ?"
    ).bind(passwordHash, savedToken.user_id),

    env.DB.prepare(
      "DELETE FROM reset_tokens WHERE user_id = ?"
    ).bind(savedToken.user_id),

    env.DB.prepare(
      "DELETE FROM sessions WHERE user_id = ?"
    ).bind(savedToken.user_id)
  ]);

  return json(
    { success: true, message: "تم تغيير كلمة المرور بنجاح. سجل الدخول من جديد." },
    200,
    request
  );
}
// ==========================================
// PART 4: CUSTOMERS & PAYMENTS
// ==========================================

// ==========================================
// GET CUSTOMERS LIST
// ==========================================

async function listCustomers(request, env, user) {
  const result = await env.DB.prepare(
    SELECT
      id,
      name,
      phone,
      address,
      purchase_name,
      total,
      paid,
      monthly,
      (total - paid) AS remaining,
      created_at
    FROM customers
    WHERE user_id = ?
    ORDER BY created_at DESC
  ).bind(user.id).all();

  return json(
    {
      success: true,
      customers: result.results  []
    },
    200,
    request
  );
}

// ==========================================
// CREATE CUSTOMER
// ==========================================

async function createCustomer(request, env, user) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const name = cleanText(body.name, 150);
  const phone = cleanText(body.phone, 30);
  const address = cleanText(body.address, 250);
  const purchaseName = cleanText(body.purchaseName, 200);

  const total = body.total;
  const paid = body.paid === undefined ? 0 : body.paid;
  const monthly = body.monthly === undefined ? 0 : body.monthly;

  if (!name  !purchaseName) {
    return json(
      { success: false, message: "يرجى إدخال اسم الزبون واسم المادة" },
      400,
      request
    );
  }

  if (
    !validAmount(total) 
    !validAmount(paid, true) 
    !validAmount(monthly, true) ||
    paid > total
  ) {
    return json(
      { success: false, message: "المبالغ المدخلة غير صحيحة" },
      400,
      request
    );
  }

  const customerId = randomHex(16);
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      INSERT INTO customers (
        id,
        user_id,
        name,
        phone,
        address,
        purchase_name,
        total,
        paid,
        monthly,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ).bind(
      customerId,
      user.id,
      name,
      phone,
      address,
      purchaseName,
      total,
      paid,
      monthly,
      now
    ),

    env.DB.prepare(
      INSERT INTO payment_history (
        id,
        customer_id,
        user_id,
        description,
        amount,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    ).bind(
      randomHex(16),
      customerId,
      user.id,
      إضافة مشتريات: ${purchaseName},
      total,
      now
    )
  ];

  if (paid > 0) {
    statements.push(
      env.DB.prepare(
        INSERT INTO payment_history (
          id,
          customer_id,
          user_id,
          description,
          amount,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      ).bind(
        randomHex(16),
        customerId,
        user.id,
        "دفعة أولية",
        -paid,
        now
      )
    );
  }

  await env.DB.batch(statements);

  return json(
    {
      success: true,
      message: "تمت إضافة الزبون بنجاح",
      customer: {
        id: customerId,
        name,
        phone,
        address,
        purchase_name: purchaseName,
        total,
        paid,
        monthly,
        remaining: total - paid,
        created_at: now
      }
    },
    201,
    request
  );
}

// ==========================================
// GET CUSTOMER DETAILS & PAYMENT HISTORY
// ==========================================

async function getCustomerDetails(request, env, user, customerId) {
  const customer = await env.DB.prepare(
    SELECT
      id,
      name,
      phone,
      address,
      purchase_name,
      total,
      paid,
      monthly,
      (total - paid) AS remaining,
      created_at
    FROM customers
    WHERE id = ? AND user_id = ?
    LIMIT 1
  ).bind(
    customerId,
    user.id
  ).first();

  if (!customer) {
    return json(
      { success: false, message: "الزبون غير موجود" },
      404,
      request
    );
  }
 const history = await env.DB.prepare(
    `SELECT
      id,
      description,
      amount,
      created_at AS date
    FROM payment_history
    WHERE customer_id = ? AND user_id = ?
    ORDER BY created_at DESC`
  ).bind(
    customerId,
    user.id
  ).all();

  return json(
    {
      success: true,
      customer,
      history: history.results || []
    },
    200,
    request
  );
}

// ==========================================
// ADD CUSTOMER PAYMENT
// ==========================================

async function addPayment(request, env, user, customerId) {
  const body = await readBody(request);

  if (!body) {
    return json(
      { success: false, message: "بيانات الطلب غير صحيحة" },
      400,
      request
    );
  }

  const amount = body.amount;
  const description = cleanText(
    body.description || "تسديد قسط",
    200
  );

  if (!validAmount(amount)) {
    return json(
      { success: false, message: "مبلغ الدفعة غير صحيح" },
      400,
      request
    );
  }

  const customer = await env.DB.prepare(
    `SELECT id, total, paid
    FROM customers
    WHERE id = ? AND user_id = ?
    LIMIT 1`
  ).bind(
    customerId,
    user.id
  ).first();

  if (!customer) {
    return json(
      { success: false, message: "الزبون غير موجود" },
      404,
      request
    );
  }

  const remaining = customer.total - customer.paid;

  if (amount > remaining) {
    return json(
      {
        success: false,
        message: "مبلغ الدفعة أكبر من المبلغ المتبقي",
        remaining
      },
      400,
      request
    );
  }

  const update = await env.DB.prepare(
    'UPDATE customers
    SET paid = paid + ?
    WHERE id = ?
      AND user_id = ?
      AND paid + ? <= total'
  ).bind(
    amount,
    customerId,
    user.id,
    amount
  ).run();

  if (!update.meta || update.meta.changes !== 1) {
    return json(
      {
        success: false,
        message: "تعذر تسجيل الدفعة. حدّث الصفحة وحاول مرة أخرى."
      },
      409,
      request
    );
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO payment_history (
      id,
      customer_id,
      user_id,
      description,
      amount,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    randomHex(16),
    customerId,
    user.id,
    description,
    amount,
    now
  ).run();

  const updatedCustomer = await env.DB.prepare(
    'SELECT
      id,
      name,
      total,
      paid,
      (total - paid) AS remaining
    FROM customers
    WHERE id = ? AND user_id = ?
    LIMIT 1'
  ).bind(
    customerId,
    user.id
  ).first();

  return json(
    {
      success: true,
      message: "تم تسجيل الدفعة بنجاح",
      customer: updatedCustomer
    },
    200,
    request
  );
}

// ==========================================
// END OF DAFTARI WORKER CODE
// ==========================================

