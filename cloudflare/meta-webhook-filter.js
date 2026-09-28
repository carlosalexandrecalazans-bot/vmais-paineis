// Cloudflare Worker — Filtro de webhook da Meta (WhatsApp Cloud API)
//
// Fica na frente do webhook "CTWA Referral Capture" do n8n. Repassa só
// mensagens reais de clientes e responde OK direto pra Meta nos callbacks
// de status (enviado/entregue/lido), que hoje gastam execução no n8n à toa.
//
// Deploy: Cloudflare → Workers & Pages → Create → Worker → colar este arquivo.

const N8N_URL = "https://vmais.app.n8n.cloud/webhook/ctwa-taynara-sofist";

// Cabeçalhos da Meta que vale manter ao repassar (ex.: assinatura).
const HEADERS_REPASSADOS = ["content-type", "x-hub-signature", "x-hub-signature-256", "user-agent"];

function repassarParaN8n(bodyText, requestOriginal) {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const nome of HEADERS_REPASSADOS) {
    const valor = requestOriginal.headers.get(nome);
    if (valor) headers.set(nome, valor);
  }
  return fetch(N8N_URL, { method: "POST", headers, body: bodyText });
}

// Devolve a lista de "changes" que trazem mensagem de cliente, em qualquer
// entry/change do payload (a Meta pode agrupar vários eventos num POST só).
function changesComMensagem(payload) {
  const resultado = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const msgs = change?.value?.messages;
      if (change?.field === "messages" && Array.isArray(msgs) && msgs.length > 0) {
        resultado.push({ entry, change });
      }
    }
  }
  return resultado;
}

async function responderComoN8n(respostas) {
  // Se algum repasse falhou, devolve o erro pra Meta tentar de novo.
  const falha = respostas.find((r) => !r.ok);
  const escolhida = falha || respostas[respostas.length - 1];
  return new Response(await escolhida.text(), {
    status: escolhida.status,
    headers: { "Content-Type": escolhida.headers.get("Content-Type") || "application/json" },
  });
}

export default {
  async fetch(request) {
    // Verificação do webhook pela Meta (GET com hub.challenge) — o n8n responde.
    if (request.method === "GET") {
      const url = new URL(request.url);
      return fetch(N8N_URL + url.search, { method: "GET" });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const bodyText = await request.text();

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (e) {
      // Corpo ilegível — por segurança repassa em vez de descartar.
      return repassarParaN8n(bodyText, request);
    }

    const comMensagem = changesComMensagem(payload);

    if (comMensagem.length === 0) {
      // Só status (sent/delivered/read) ou outro evento sem mensagem de cliente.
      return new Response(JSON.stringify({ status: "ignored" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Caso comum: um único evento com mensagem — repassa o corpo original intacto.
    const totalChanges = (payload.entry || []).reduce((n, e) => n + (e?.changes?.length || 0), 0);
    if (comMensagem.length === 1 && totalChanges === 1) {
      return repassarParaN8n(bodyText, request);
    }

    // Lote misturado: o n8n só lê entry[0].changes[0], então manda cada
    // mensagem separada, sem os status junto.
    const respostas = [];
    for (const { entry, change } of comMensagem) {
      const unico = { ...payload, entry: [{ ...entry, changes: [change] }] };
      respostas.push(await repassarParaN8n(JSON.stringify(unico), request));
    }
    return responderComoN8n(respostas);
  },
};
