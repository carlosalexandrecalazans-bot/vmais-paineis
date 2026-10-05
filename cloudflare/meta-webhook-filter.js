// Cloudflare Worker — filtro do webhook da Meta (WhatsApp) na frente do n8n.
// Atende dois números (roteia pelo phone_number_id):
//
// Sofist Laser
// - Status (enviado/entregue/lido): responde OK e não repassa.
// - Mensagem de cliente: responde OK pra Meta NA HORA (evita o reenvio que a
//   Meta faz quando a resposta passa de ~20s) e entrega ao n8n em segundo plano.
//   Se o n8n recusar/cair logo de cara, tenta de novo algumas vezes.
//
// Star Motors
// - TODA mensagem de cliente (texto, foto, áudio, botão) é gravada direto no
//   Supabase (tabela star_motors_mensagens) — sem gastar execução do n8n.
// - Só o toque nos botões da campanha ("Quero saber mais" / "Não tenho
//   interesse", ou sair/parar...) segue pro n8n, que marca a planilha.
//
// Variáveis do Worker (Settings > Variables and Secrets):
// - SUPABASE_KEY (secret): service_role key do projeto Supabase.
// - VERIFY_TOKEN (opcional): token de verificação do webhook na Meta.

const N8N_SOFIST = "https://vmais.app.n8n.cloud/webhook/ctwa-taynara-sofist";
const N8N_STAR_MOTORS = "https://vmais.app.n8n.cloud/webhook/star-motors-respostas";
const SUPABASE_URL = "https://tishvpoxekxocyzdiaja.supabase.co";

const PHONE_STAR_MOTORS = "1170154492850086";
const VERIFY_TOKEN_PADRAO = "6ce7d877e49cbfdbfec65de6eafc3ee4e6e4d3861d0df402";

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

async function entregarAoN8n(url, body, headers) {
  for (let i = 1; i <= TENTATIVAS; i++) {
    const inicio = Date.now();
    try {
      const r = await fetch(url, { method: "POST", headers, body });
      if (r.status < 500) return r.ok;
      console.log(`n8n respondeu ${r.status} (tentativa ${i})`);
    } catch (e) {
      console.log(`n8n inalcançável (tentativa ${i}): ${e}`);
    }
    // Erro depois de muito tempo = o n8n já estava processando; não duplica.
    if (Date.now() - inicio > FALHA_RAPIDA_MS) return false;
    if (i < TENTATIVAS) await new Promise((ok) => setTimeout(ok, ESPERA_MS));
  }
  return false;
}

// Uma "mensagem" = payload com uma única change que tem messages[].
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

function phoneIdDe(m) {
  return m.entry[0].changes[0].value?.metadata?.phone_number_id || "";
}

// ---------- Star Motors ----------

function textoDaMensagem(msg) {
  switch (msg.type) {
    case "text": return msg.text?.body || "";
    case "button": return msg.button?.text || msg.button?.payload || "";
    case "interactive":
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
    case "image": return msg.image?.caption || "[foto]";
    case "video": return msg.video?.caption || "[vídeo]";
    case "document": return msg.document?.caption || msg.document?.filename || "[documento]";
    case "audio": return "[áudio]";
    case "sticker": return "[figurinha]";
    case "location": return "[localização]";
    case "contacts": return "[contato]";
    case "reaction": return `[reação ${msg.reaction?.emoji || ""}]`.trim();
    default: return `[${msg.type || "mensagem"}]`;
  }
}

function midiaIdDe(msg) {
  const m = msg[msg.type];
  return (m && typeof m === "object" && m.id) || null;
}

function normalizar(t) {
  return String(t || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[.!?]+$/g, "").trim();
}

// Mesma regra do n8n ("Extrair Resposta"): só os botões da campanha contam.
function ehRespostaDaCampanha(msg) {
  if (!["text", "button", "interactive"].includes(msg.type)) return false;
  const t = normalizar(textoDaMensagem(msg));
  return t === "quero saber mais" ||
    t === "nao tenho interesse" ||
    /^(sair|parar|pare|stop|cancelar|descadastrar)$/.test(t);
}

async function gravarNoSupabase(env, linhas) {
  if (!env.SUPABASE_KEY) {
    console.log("SUPABASE_KEY não configurada — mensagens da Star Motors não foram gravadas");
    return;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/star_motors_mensagens?on_conflict=wamid`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(linhas),
    });
    if (!r.ok) console.log(`Supabase respondeu ${r.status}: ${await r.text()}`);
  } catch (e) {
    console.log(`Supabase inalcançável: ${e}`);
  }
}

async function processarStarMotors(env, payloadMsg, headers) {
  const value = payloadMsg.entry[0].changes[0].value;
  const nomes = {};
  for (const c of value.contacts || []) nomes[c.wa_id] = c.profile?.name || null;

  const linhas = [];
  let temBotao = false;
  for (const msg of value.messages) {
    const botao = ehRespostaDaCampanha(msg);
    temBotao = temBotao || botao;
    linhas.push({
      wamid: msg.id,
      phone_number_id: value.metadata?.phone_number_id || null,
      telefone: String(msg.from || ""),
      nome: nomes[msg.from] || null,
      tipo: msg.type || null,
      texto: textoDaMensagem(msg),
      midia_id: midiaIdDe(msg),
      botao,
      enviado_em: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null,
      raw: msg,
    });
  }

  let enviado = false;
  if (temBotao) enviado = await entregarAoN8n(N8N_STAR_MOTORS, JSON.stringify(payloadMsg), headers);
  for (const l of linhas) l.enviado_ao_n8n = l.botao && enviado;
  await gravarNoSupabase(env, linhas);
}

// ---------- Worker ----------

const OK = () =>
  new Response('{"status":"ok"}', { status: 200, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      // Verificação do webhook pela Meta (hub.challenge) — respondida aqui,
      // sem depender do n8n estar ligado.
      const url = new URL(request.url);
      const token = env.VERIFY_TOKEN || VERIFY_TOKEN_PADRAO;
      if (url.searchParams.get("hub.mode") === "subscribe" &&
          url.searchParams.get("hub.verify_token") === token) {
        return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
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
      ctx.waitUntil(entregarAoN8n(N8N_SOFIST, bodyText, headers));
      return OK();
    }

    const mensagens = mensagensDoPayload(payload);
    if (mensagens.length === 0) {
      return new Response('{"status":"ignored"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Cada mensagem num POST próprio (o n8n da Sofist só lê entry[0].changes[0]).
    ctx.waitUntil(
      (async () => {
        for (const m of mensagens) {
          if (phoneIdDe(m) === PHONE_STAR_MOTORS) await processarStarMotors(env, m, headers);
          else await entregarAoN8n(N8N_SOFIST, JSON.stringify(m), headers);
        }
      })()
    );
    return OK();
  },
};
