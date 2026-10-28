export async function onRequest(context) {
  try {
    const { results } = await context.env.DB.prepare("SELECT * FROM stores").all()
    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    })
  } catch (e) {
    return new Response("DB not connected yet: " + e.message, { status: 500 })
  }
}
