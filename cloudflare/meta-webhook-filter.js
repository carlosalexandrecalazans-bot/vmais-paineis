// Cloudflare Worker — filtro do webhook da Meta (WhatsApp) na frente do n8n.
// - Status (enviado/entregue/lido): responde OK e não repassa.
// - Mensagem de cliente: responde OK pra Meta NA HORA (evita o reenvio que a
//   Meta faz quando a resposta passa de ~20s) e entrega ao n8n em segundo plano.
//   Se o n8n recusar/cair logo de cara, tenta de novo algumas vezes.
// Erros da IA são tratados dentro do n8n (retry no nó da Sofia).

const N8N_URL = "https://vmais.app.n8n.cloud/webhook/ctwa-taynara-sofist";
const HEADERS_REPASSADOS = ["content-type", "x-hub-signature", "x-hub-signature-256", "user-agent"];
const TENTATIVAS = 3;
const ESPERA_MS = 4000;
const FALHA_RAPIDA_MS = 8000; // erro antes disso = n8n não processou, pode tentar de novo

function montarHeaders(req) {
  const h = new Headers({ "Content-Type": "application/json" });
  for (const nome of HEADERS_REPASSADOS) {
    const v = req.headers.get(nome);
    if (v) h.set(nome, v);
  }
  return h;
}

async function entregarAoN8n(body, headers) {
  for (let i = 1; i <= TENTATIVAS; i++) {
    const inicio = Date.now();
    try {
      const r = await fetch(N8N_URL, { method: "POST", headers, body });
      if (r.status < 500) return;
      console.log(`n8n respondeu ${r.status} (tentativa ${i})`);
    } catch (e) {
      console.log(`n8n inalcançável (tentativa ${i}): ${e}`);
    }
    // Erro depois de muito tempo = o n8n já estava processando; não duplica.
    if (Date.now() - inicio > FALHA_RAPIDA_MS) return;
    if (i < TENTATIVAS) await new Promise((ok) => setTimeout(ok, ESPERA_MS));
  }
}

function mensagensDoPayload(payload) {
  const lista = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const msgs = change?.value?.messages;
      if (change?.field === "messages" && Array.isArray(msgs) && msgs.length > 0) {
        lista.push({ ...payload, entry: [{ ...entry, changes: [change] }] });
      }
    }
  }
  return lista;
}

const OK = () =>
  new Response('{"status":"ok"}', { status: 200, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      return fetch(N8N_URL + url.search, { method: "GET" });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const bodyText = await request.text();
    const headers = montarHeaders(request);

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (e) {
      ctx.waitUntil(entregarAoN8n(bodyText, headers));
      return OK();
    }

    const mensagens = mensagensDoPayload(payload);
    if (mensagens.length === 0) {
      return new Response('{"status":"ignored"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // n8n só lê entry[0].changes[0]: manda cada mensagem num POST próprio.
    ctx.waitUntil(
      (async () => {
        for (const m of mensagens) await entregarAoN8n(JSON.stringify(m), headers);
      })()
    );
    return OK();
  },
};
