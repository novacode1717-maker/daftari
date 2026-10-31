/*
 * Daftari - Cloudflare Workers + D1
 * File: index.js
 *
 * Required bindings:
 *   DB              -> Cloudflare D1 database
 *
 * Required secrets/settings for email:
 *   RESEND_API_KEY  -> Resend API key
 *   MAIL_FROM       -> Verified sender, e.g. Daftari <noreply@example.com>
 *   APP_BASE_URL    -> Public URL of your application
 */

const SESSION_DAYS = 7;
const CODE_MINUTES = 10;
const RESET_MINUTES = 30;
const PASSWORD_ITERATIONS = 310000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
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
        return json({ error: "قاعدة البيانات DB غير مربوطة بإعدادات Workers." }, 500, request);
      }

      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method.toUpperCase();

      if (method === "GET" && path === "/api/health") {
        return json({ status: "ok", service: "daftari" }, 200, request);
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

      // Customer list and creation
      if (method === "GET" && path === "/api/customers") {
        const session = await requireSession(request, env);
        if (session.error) return session.error;

        const result = await env.DB.prepare(
          SELECT
            c.id,
            c.name,
            c.phone,
            c.address,
            c.purchase_name AS purchaseName,
            c.total,
            c.paid,
            c.monthly,
            (c.total - c.paid) AS remaining,
            c.created_at AS createdAt
          FROM customers c
          WHERE c.owner_id = ?
          ORDER BY c.created_at DESC
        ).bind(session.user.id).all();

        return json({ customers: result.results || [] }, 200, request);
      }

      if (method === "POST" && path === "/api/customers") {
        const session = await requireSession(request, env);
        if (session.error) return session.error;
        return await createCustomer(request, env, session.user);
      }

      // Customer details: /api/customers/:id
      const customerMatch = path.match(/^\/api\/customers\/([^/]+)$/);

      if (method === "GET" && customerMatch) {
        const session = await requireSession(request, env);
        if (session.error) return session.error;

        const customer = await getCustomer(
          env,
          session.user.id,
          customerMatch[1]
        );

        if (!customer) {
          return json({ error: "الزبون غير موجود." }, 404, request);
        }

        const history = await env.DB.prepare(
          SELECT id, description, amount, date
          FROM customer_history
          WHERE owner_id = ? AND customer_id = ?
          ORDER BY created_at DESC
        ).bind(session.user.id, customer.id).all();

        return json({
          ...customer,
          history: history.results || []
            }, 200, request);
      }

      // Payment: POST /api/customers/:id/payments
      const paymentMatch = path.match(
        /^\/api\/customers\/([^/]+)\/payments$/
      );

      if (method === "POST" && paymentMatch) {
        const session = await requireSession(request, env);
        if (session.error) return session.error;

        return await addPayment(
          request,
          env,
          session.user.id,
          paymentMatch[1]
        );
      }

      return json({ error: "المسار المطلوب غير موجود." }, 404, request);

    } catch (error) {
      console.error("Daftari Worker error:", error);

      return json({
        error: "حدث خطأ داخلي. تحقق من إعدادات الخادم وقاعدة البيانات."
      }, 500, request);
    }
  }
};


// --------------------------------------------------
// General helpers
// --------------------------------------------------

function json(data, status = 200, request = null, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });

  if (request) {
    headers.set("Access-Control-Allow-Origin", new URL(request.url).origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function cookieOptions(request, maxAge) {
  const secure = new URL(request.url).protocol === "https:";

  return [
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    Max-Age=${maxAge},
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function clearCookie(request) {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": daftari_session=; ${cookieOptions(request, 0)},
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": new URL(request.url).origin,
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin"
    }
  });
}

async function readBody(request) {
  const type = request.headers.get("content-type")  "";

  if (!type.includes("application/json")) {
    throw new Error("يجب إرسال البيانات بصيغة JSON.");
  }

  let body;

  try {
    body = await request.json();
  } catch {
    throw new Error("صيغة البيانات غير صحيحة.");
  }

  if (!body  typeof body !== "object" || Array.isArray(body)) {
    throw new Error("البيانات المرسلة غير صحيحة.");
  }

  return body;
}

function cleanText(value, max = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeEmail(value) {
  return cleanText(value, 254).toLowerCase();
}

function validAmount(value, allowZero = false) {
  return Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0);
}

function randomHex(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));

  return Array.from(data)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomCode() {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return String(values[0] % 1000000).padStart(6, "0");
}

async function sha256(value) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(result))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations: PASSWORD_ITERATIONS,
    hash: "SHA-256"
  }, key, 256);

  const saltHex = Array.from(salt)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  const hashHex = Array.from(new Uint8Array(bits))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  return pbkdf2$${PASSWORD_ITERATIONS}$${saltHex}$${hashHex};
}

async function verifyPassword(password, stored) {
  try {
    const parts = stored.split("$");

    if (parts.length !== 4  parts[0] !== "pbkdf2") {
      return false;
    }

    const iterations = Number(parts[1]);

    if (!Number.isInteger(iterations) 
        iterations < 100000 
        iterations > 1000000) {
      return false;
    }

    const salt = new Uint8Array(
      parts[2].match(/.{2}/g).map(byte => parseInt(byte, 16))
    );

    const expected = parts[3];

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    }, key, 256);

    const actual = Array.from(new Uint8Array(bits))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    return actual === expected;
  } catch {
    return false;
  }
}

function expiration(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function isExpired(value) {
  return !value  Date.parse(value) <= Date.now();
}

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    throw new Error(
      "إعداد البريد غير مكتمل. أضف RESEND_API_KEY وMAIL_FROM."
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": Bearer ${env.RESEND_API_KEY},
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
    console.error("Email provider failed:", response.status);
    throw new Error("تعذر إرسال البريد الإلكتروني. تحقق من إعدادات البريد.");
  }
}

function emailCodeHtml(code) {
  return 
    <div dir="rtl" style="font-family:Arial,sans-serif">
      <h2>دفتري - تأكيد البريد الإلكتروني</h2>
      <p>رمز التحقق الخاص بك:</p>
      <div style="font-size:30px;font-weight:bold;letter-spacing:6px">
        ${code}
      </div>
      <p>صلاحية الرمز عشر دقائق. لا تشاركه مع أحد.</p>
    </div>
  ;
}

async function createEmailCode(env, user) {
  const code = randomCode();
  const codeHash = await sha256(code);

  await env.DB.prepare(
    DELETE FROM email_codes
    WHERE user_id = ?
  ).bind(user.id).run();

  await env.DB.prepare(
    INSERT INTO email_codes
      (id, user_id, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  ).bind(
    crypto.randomUUID(),
    user.id,
    codeHash,
    expiration(CODE_MINUTES),
    new Date().toISOString()
  ).run();

  await sendEmail(
    env,
    user.email,
    "رمز التحقق - دفتري",
    emailCodeHtml(code)
  );
}


// --------------------------------------------------
// Session and authentication helpers
// --------------------------------------------------

async function createSession(request, env, userId) {
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = expiration(SESSION_DAYS * 24 * 60);

  await env.DB.prepare(
    INSERT INTO sessions
      (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  ).bind(
    crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt,
    new Date().toISOString()
  ).run();

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": daftari_session=${token}; ${cookieOptions(
        request,
        SESSION_DAYS * 24 * 60 * 60
      )},
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": new URL(request.url).origin,
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin"
    }
  });
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator < 0) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === name) return value;
  }

  return "";
}

async function requireSession(request, env) {
  const token = getCookie(request, "daftari_session");

  if (!token) {
    return {
      error: json({ error: "سجّل الدخول أولاً." }, 401, request)
    };
  }

  const tokenHash = await sha256(token);

  const row = await env.DB.prepare(
    SELECT
      s.id AS session_id,
      s.expires_at,
      u.id,
      u.owner_name,
      u.shop_name,
      u.shop_address,
      u.email,
      u.email_verified
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
    LIMIT 1
  ).bind(tokenHash).first();

  if (!row || isExpired(row.expires_at)) {
    if (row) {
      await env.DB.prepare(
        DELETE FROM sessions WHERE id = ?
      ).bind(row.session_id).run();
    }

    return {
      error: json({ error: "انتهت الجلسة. سجّل الدخول من جديد." }, 401, request)
    };
  }

  if (!row.email_verified) {
    return {
      error: json({ error: "يجب تأكيد البريد الإلكتروني أولاً." }, 403, request)
    };
  }

  return {
    user: {
      id: row.id,
      ownerName: row.owner_name,
      shopName: row.shop_name,
      shopAddress: row.shop_address,
      email: row.email
    }
  };
}


// --------------------------------------------------
// Register
// --------------------------------------------------

async function register(request, env) {
  const body = await readBody(request);

  const ownerName = cleanText(body.ownerName, 120);
  const fatherName = cleanText(body.fatherName, 120);
  const shopName = cleanText(body.shopName, 160);
  const shopAddress = cleanText(body.shopAddress, 250);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if (!ownerName  !fatherName  !shopName  !shopAddress) {
    return json({ error: "املأ جميع حقول التسجيل." }, 400, request);
  }

  if (!validEmail(email)) {
    return json({ error: "البريد الإلكتروني غير صحيح." }, 400, request);
  }

  if (password.length < 12  password.length > 128) {
    return json({
      error: "كلمة المرور يجب أن تكون بين 12 و128 حرفاً."
    }, 400, request);
  }

  const existing = await env.DB.prepare(
    SELECT id FROM users WHERE email = ? LIMIT 1
  ).bind(email).first();

  if (existing) {
    return json({
      error: "هذا البريد مسجل مسبقاً. جرّب تسجيل الدخول أو استرجاع كلمة المرور."
    }, 409, request);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  await env.DB.prepare(
    INSERT INTO users
      (id, owner_name, father_name, shop_name, shop_address,
       email, password_hash, email_verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  ).bind(
    id,
    ownerName,
    fatherName,
    shopName,
    shopAddress,
    email,
    passwordHash,
    now
  ).run();

  try {
    await createEmailCode(env, {
      id,
      email
    });
  } catch (error) {
    console.error("Registration email failed:", error);

    return json({
      success: true,
      needsVerification: true,
      message: "تم إنشاء الحساب، لكن تعذر إرسال رمز التحقق. تحقق من إعدادات البريد ثم اطلب إعادة إرسال الرمز."
    }, 201, request);
  }

  return json({
    success: true,
    needsVerification: true,
    message: "تم إنشاء الحساب وإرسال رمز التحقق."
  }, 201, request);
}


// --------------------------------------------------
// Verify email and resend code
// --------------------------------------------------

async function verifyEmail(request, env) {
  const body = await readBody(request);
  const email = normalizeEmail(body.email);
  const code = cleanText(body.code, 6);

  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return json({ error: "أدخل البريد الصحيح ورمز التحقق المكوّن من 6 أرقام." }, 400, request);
  }
  const user = await env.DB.prepare(
    SELECT id, email_verified
    FROM users
    WHERE email = ?
    LIMIT 1
  ).bind(email).first();

  if (!user) {
    return json({ error: "تعذر تأكيد البريد. تحقق من البيانات." }, 400, request);
  }

  if (user.email_verified) {
    return json({ success: true, message: "البريد مؤكد مسبقاً." }, 200, request);
  }

  const row = await env.DB.prepare(
    SELECT id, code_hash, expires_at
    FROM email_codes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  ).bind(user.id).first();

  if (!row || isExpired(row.expires_at)) {
    return json({ error: "انتهت صلاحية الرمز. اطلب رمزاً جديداً." }, 400, request);
  }

  const codeHash = await sha256(code);

  if (codeHash !== row.code_hash) {
    return json({ error: "رمز التحقق غير صحيح." }, 400, request);
  }

  await env.DB.batch([
    env.DB.prepare(
      UPDATE users SET email_verified = 1 WHERE id = ?
    ).bind(user.id),

    env.DB.prepare(
      DELETE FROM email_codes WHERE user_id = ?
    ).bind(user.id)
  ]);

  return json({
    success: true,
    message: "تم تأكيد البريد الإلكتروني."
  }, 200, request);
}

async function resendCode(request, env) {
  const body = await readBody(request);
  const email = normalizeEmail(body.email);

  if (!validEmail(email)) {
    return json({ error: "أدخل بريداً إلكترونياً صحيحاً." }, 400, request);
  }

  const user = await env.DB.prepare(
    SELECT id, email, email_verified
    FROM users
    WHERE email = ?
    LIMIT 1
  ).bind(email).first();

  // Avoid disclosing whether an account exists.
  if (!user  user.email_verified) {
    return json({
      success: true,
      message: "إذا كان الحساب بحاجة إلى التحقق، فستتم معالجة الطلب."
    }, 200, request);
  }

  await createEmailCode(env, user);

  return json({
    success: true,
    message: "تم إرسال رمز جديد."
  }, 200, request);
}


// --------------------------------------------------
// Login and logout
// --------------------------------------------------

async function login(request, env) {
  const body = await readBody(request);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if (!validEmail(email)  !password) {
    return json({ error: "أدخل البريد الإلكتروني وكلمة المرور." }, 400, request);
  }

  const user = await env.DB.prepare(
    SELECT id, shop_name, email, password_hash, email_verified
    FROM users
    WHERE email = ?
    LIMIT 1
  ).bind(email).first();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة." }, 401, request);
  }

  if (!user.email_verified) {
    return json({
      error: "أكد بريدك الإلكتروني أولاً. استخدم خيار إعادة إرسال الرمز."
    }, 403, request);
  }

  return await createSession(request, env, user.id).then(async response => {
    // Keep the same session cookie and return shop information.
    const headers = new Headers(response.headers);
    return new Response(JSON.stringify({
      success: true,
      shopName: user.shop_name,
      user: {
        email: user.email,
        shopName: user.shop_name
      }
    }), {
      status: 200,
      headers
    });
  });
}

async function logout(request, env) {
  const token = getCookie(request, "daftari_session");

  if (token) {
    const tokenHash = await sha256(token);

    await env.DB.prepare(
      DELETE FROM sessions WHERE token_hash = ?
    ).bind(tokenHash).run();
  }

  return clearCookie(request);
}


// --------------------------------------------------
// Forgot and reset password
// --------------------------------------------------

async function forgotPassword(request, env) {
  const body = await readBody(request);
  const email = normalizeEmail(body.email);

  if (!validEmail(email)) {
    return json({ error: "أدخل بريداً إلكترونياً صحيحاً." }, 400, request);
  }

  const user = await env.DB.prepare(
    SELECT id, email
    FROM users
    WHERE email = ? AND email_verified = 1
    LIMIT 1
  ).bind(email).first();
  // Same response whether the account exists or not.
  if (!user) {
    return json({
      success: true,
      message: "إذا كان البريد مسجلاً، ستصلك تعليمات الاسترجاع."
    }, 200, request);
  }

  const token = randomHex(32);
  const tokenHash = await sha256(token);

  await env.DB.prepare(
    DELETE FROM password_resets WHERE user_id = ?
  ).bind(user.id).run();

  await env.DB.prepare(
    INSERT INTO password_resets
      (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  ).bind(
    crypto.randomUUID(),
    user.id,
    tokenHash,
    expiration(RESET_MINUTES),
    new Date().toISOString()
  ).run();

  const baseUrl = String(env.APP_BASE_URL || "").replace(/\/+$/, "");

  if (!baseUrl) {
    return json({
      error: "إعداد APP_BASE_URL مفقود. أضف رابط موقعك في إعدادات Workers."
    }, 500, request);
  }

  const resetUrl = ${baseUrl}/?token=${encodeURIComponent(token)};

  const html = 
    <div dir="rtl" style="font-family:Arial,sans-serif">
      <h2>دفتري - استرجاع كلمة المرور</h2>
      <p>طلبت تغيير كلمة المرور لحسابك.</p>
      <p>
        <a href="${resetUrl}"
           style="background:#ffd700;color:#111;padding:12px 18px;
                  text-decoration:none;border-radius:8px">
          تغيير كلمة المرور
        </a>
      </p>
      <p>الرابط صالح لمدة 30 دقيقة ويستخدم مرة واحدة.</p>
      <p>إذا لم تطلب التغيير، تجاهل هذه الرسالة.</p>
    </div>
  ;

  try {
    await sendEmail(env, user.email, "استرجاع كلمة المرور - دفتري", html);
  } catch (error) {
    console.error("Password reset email failed:", error);

    return json({
      error: "تعذر إرسال رسالة الاسترجاع. تحقق من إعدادات البريد الإلكتروني."
    }, 500, request);
  }

  return json({
    success: true,
    message: "إذا كان البريد مسجلاً، ستصلك تعليمات الاسترجاع."
  }, 200, request);
}

async function resetPassword(request, env) {
  const body = await readBody(request);

  const token = cleanText(body.token, 200);
  const password = typeof body.password === "string" ? body.password : "";

  if (!token  token.length < 32) {
    return json({ error: "رابط الاسترجاع غير صالح." }, 400, request);
  }

  if (password.length < 12  password.length > 128) {
    return json({
      error: "كلمة المرور يجب أن تكون بين 12 و128 حرفاً."
    }, 400, request);
  }

  const tokenHash = await sha256(token);

  const reset = await env.DB.prepare(
    SELECT id, user_id, expires_at
    FROM password_resets
    WHERE token_hash = ?
    LIMIT 1
  ).bind(tokenHash).first();

  if (!reset || isExpired(reset.expires_at)) {
    return json({
      error: "انتهت صلاحية رابط الاسترجاع أو تم استخدامه مسبقاً."
    }, 400, request);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      UPDATE users SET password_hash = ? WHERE id = ?
    ).bind(passwordHash, reset.user_id),

    env.DB.prepare(
      DELETE FROM password_resets WHERE user_id = ?
    ).bind(reset.user_id),

    env.DB.prepare(
      DELETE FROM sessions WHERE user_id = ?
    ).bind(reset.user_id)
  ]);

  return json({
    success: true,
    message: "تم تغيير كلمة المرور. سجّل الدخول من جديد."
  }, 200, request);
}


// --------------------------------------------------
// Customers
// --------------------------------------------------

async function createCustomer(request, env, user) {
  const body = await readBody(request);

  const name = cleanText(body.name, 160);
  const phone = cleanText(body.phone, 40);
  const address = cleanText(body.address, 250);
  const purchaseName = cleanText(body.purchaseName, 200);

  const total = body.total;
  const paid = body.paid;
  const monthly = body.monthly;

  if (!name  !purchaseName) {
    return json({
      error: "اسم الزبون واسم المشتريات حقول مطلوبة."
    }, 400, request);
  }

  if (!validAmount(total) 
      !validAmount(paid, true) 
      paid > total 
      !validAmount(monthly, true)) {
    return json({
      error: "تحقق من المبالغ. يجب ألا يكون المدفوع أكبر من المبلغ الكلي."
    }, 400, request);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    INSERT INTO customers
      (id, owner_id, name, phone, address, purchase_name,
       total, paid, monthly, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ).bind(
    id,
    user.id,
    name,
    phone,
    address,
    purchaseName,
    total,
    paid,
    monthly,
    now,
    now
  ).run();

  await env.DB.prepare(
    INSERT INTO customer_history
      (id, owner_id, customer_id, description, amount, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  ).bind(
    crypto.randomUUID(),
    user.id,
    id,
    "مشتريات: " + purchaseName,
    total,
    now.slice(0, 10),
    now
  ).run();

  if (paid > 0) {
    await env.DB.prepare(
      INSERT INTO customer_history
        (id, owner_id, customer_id, description, amount, date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    ).bind(
      crypto.randomUUID(),
      user.id,
      id,
      "دفعة أولية",
      -paid,
      now.slice(0, 10),
      now
    ).run();
  }

  return json({
    success: true,
    id,
    message: "تم حفظ الزبون بنجاح."
  }, 201, request);
}

async function getCustomer(env, ownerId, customerId) {
  return await env.DB.prepare(
    SELECT
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
    WHERE id = ? AND owner_id = ?
    LIMIT 1
  ).bind(customerId, ownerId).first();
}

async function addPayment(request, env, ownerId, customerId) {
  const body = await readBody(request);
  const amount = body.amount;

  if (!validAmount(amount)) {
    return json({ error: "أدخل مبلغ دفعة صحيحاً." }, 400, request);
  }

  const customer = await getCustomer(env, ownerId, customerId);

  if (!customer) {
    return json({ error: "الزبون غير موجود." }, 404, request);
  }

  const remaining = Number(customer.total) - Number(customer.paid);

  if (amount > remaining) {
    return json({
      error: "مبلغ الدفعة أكبر من المبلغ المتبقي على الزبون."
    }, 400, request);
  }

  const now = new Date().toISOString();

  // Both updates are performed as one D1 batch.
  await env.DB.batch([
    env.DB.prepare(
      UPDATE customers
      SET paid = paid + ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    ).bind(amount, now, customerId, ownerId),

    env.DB.prepare(
      INSERT INTO customer_history
        (id, owner_id, customer_id, description, amount, date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    ).bind(
      crypto.randomUUID(),
      ownerId,
      customerId,
      "دفعة مستلمة",
      -amount,
      now.slice(0, 10),
      now
    )
  ]);

  return json({
    success: true,
    message: "تم تسجيل الدفعة بنجاح."
  }, 200, request);
}
