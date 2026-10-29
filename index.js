export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. إذا كان الطلب لملف API (عشان جلب بيانات الزبائن لاحقاً)
    if (url.pathname.startsWith('/api/')) {
      // هنا راح نكتب كود جلب البيانات من الداتابيس لاحقاً
      return new Response(JSON.stringify({ message: "API is working" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. أي طلب ثاني (مثل فتح الصفحة الرئيسية)، خليه يروح لملفات الـ HTML
    // هذا الأمر يخلي كلودفلير يجيب ملف index.html وملفاته من الـ Assets
    return env.ASSETS.fetch(request);
  }
};
