// Cloudflare Worker — Filtro de webhook da Meta (WhatsApp Cloud API)
//
// Fica na frente do webhook "CTWA Referral Capture" do n8n:
// 1. Callbacks de status (enviado/entregue/lido) → responde OK e NÃO repassa.
// 2. Mensagem de cliente → repassa ao n8n e devolve a resposta dele pra Meta.
//    Se o n8n falhar, a Meta recebe o erro e reenvia (nenhuma mensagem se perde).
// 3. Reenvio de mensagem que o n8n JÁ processou com sucesso → responde OK sem
//    repassar (economiza execução e evita a Sofia ler a mesma pergunta 2x).
//    Reenvio de mensagem ainda em processamento → responde 503 pra Meta tentar
//    de novo mais tarde (se a 1ª tentativa falhar, a próxima passa).
//
// O item 3 precisa de um namespace KV ligado ao Worker com o nome MSG_IDS
// (Settings → Bindings → KV namespace). Sem ele o Worker funciona igual,
// só sem a proteção contra reenvio.
//
// Deploy: Cloudflare → Workers & Pages → meta-webhook-filter → Edit code.

const N8N_URL = "https://vmais.app.n8n.cloud/webhook/ctwa-taynara-sofist";

// Cabeçalhos da Meta que vale manter ao repassar (ex.: assinatura).
const HEADERS_REPASSADOS = ["content-type", "x-hub-signature", "x-hub-signature-256", "user-agent"];

const TTL_PROCESSANDO_S = 120; // tempo máximo esperado de uma execução do n8n
const TTL_PROCESSADA_S = 2 * 24 * 60 * 60; // a Meta reenvia por até ~36h

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

function idsDasMensagens(change) {
  return (change?.value?.messages || []).map((m) => m?.id).filter(Boolean);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Repassa uma mensagem (um change) ao n8n com proteção contra reenvio.
// Retorna a Response que deve ir pra Meta.
async function processarMensagem(bodyText, request, change, kv) {
  const ids = idsDasMensagens(change);
  const chave = ids.length ? "msg:" + ids.join(",") : null;

  if (kv && chave) {
    const estado = await kv.get(chave);
    if (estado === "ok") return json({ status: "duplicate" });
    if (estado === "processando") {
      // Primeira tentativa ainda rodando no n8n — pede pra Meta tentar depois.
      return new Response("still processing", { status: 503, headers: { "Retry-After": "30" } });
    }
    await kv.put(chave, "processando", { expirationTtl: TTL_PROCESSANDO_S });
  }

  let resposta;
  try {
    resposta = await repassarParaN8n(bodyText, request);
  } catch (e) {
    resposta = new Response("n8n unreachable", { status: 502 });
  }

  if (kv && chave) {
    if (resposta.ok) {
      await kv.put(chave, "ok", { expirationTtl: TTL_PROCESSADA_S });
    } else {
      await kv.delete(chave); // deixa o reenvio da Meta passar
    }
  }
  return resposta;
}

async function copiarResposta(r) {
  return new Response(await r.text(), {
    status: r.status,
    headers: { "Content-Type": r.headers.get("Content-Type") || "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const kv = env && env.MSG_IDS;

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
      return json({ status: "ignored" });
    }

    // Caso comum: um único evento com mensagem — repassa o corpo original intacto.
    const totalChanges = (payload.entry || []).reduce((n, e) => n + (e?.changes?.length || 0), 0);
    if (comMensagem.length === 1 && totalChanges === 1) {
      return processarMensagem(bodyText, request, comMensagem[0].change, kv);
    }

    // Lote misturado: o n8n só lê entry[0].changes[0], então manda cada
    // mensagem separada, sem os status junto. Se alguma falhar, devolve o erro
    // pra Meta reenviar o lote — as que já deram certo viram "duplicate".
    let falha = null;
    let ultima = null;
    for (const { entry, change } of comMensagem) {
      const unico = { ...payload, entry: [{ ...entry, changes: [change] }] };
      const r = await processarMensagem(JSON.stringify(unico), request, change, kv);
      if (!r.ok && !falha) falha = r;
      ultima = r;
    }
    return copiarResposta(falha || ultima);
  },
};
