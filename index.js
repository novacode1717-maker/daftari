export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. التعامل مع طلبات API الخاصة بالزبائن
    if (url.pathname === '/api/customers') {
      
      // إذا كان الطلب جلب بيانات (GET)
      if (request.method === 'GET') {
        try {
          const { results } = await env.DB.prepare("SELECT * FROM customers ORDER BY id DESC").all();
          return new Response(JSON.stringify(results), {
            headers: { "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
      }

      // إذا كان الطلب إضافة بيانات (POST)
      if (request.method === 'POST') {
        try {
          const { name, phone } = await request.json();
          await env.DB.prepare("INSERT INTO customers (name, phone) VALUES (?, ?)").bind(name, phone).run();
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
      }
    }

    // 2. أي طلب آخر (مثل فتح الصفحة)، يروح لملفات الـ HTML
    return env.ASSETS.fetch(request);
  }
};
