export default {
  async fetch(request, env) {
    // هنا يمكنك كتابة أوامر SQL للاتصال بقاعدة البيانات
    // مثال: const result = await env.DB.prepare("SELECT * FROM your_table").all();
    return new Response("Worker is connected to D1!", { status: 200 });
  }
};

