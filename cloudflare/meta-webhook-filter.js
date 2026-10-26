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
//   Supabase (tabela star_motors_mensagens).
// - O toque nos botões da campanha ("Quero saber mais" / "Não tenho
//   interesse", ou sair/parar...) segue pro n8n de respostas, que marca a planilha.
// - Agrupamento pro Aquecimento: o cliente costuma mandar várias mensagens em
//   sequência ("oi", "tudo bem?", "qual o valor?"). O Worker espera
//   AGRUPAR_MS sem mensagem nova daquele telefone e manda os textos juntos numa
//   única mensagem pro n8n — uma execução e uma resposta da IA em vez de várias.
//   Foto e áudio seguem um por um (o n8n analisa/transcreve cada mídia).
//   A marcação enviado_ao_n8n=true no Supabase indica o que já foi pro Aquecimento.
//
// Variáveis do Worker (Settings > Variables and Secrets):
// - SUPABASE_KEY (secret): service_role key do projeto Supabase.
// - VERIFY_TOKEN (opcional): token de verificação do webhook na Meta.

const N8N_SOFIST = "https://vmais.app.n8n.cloud/webhook/ctwa-taynara-sofist";
const N8N_STAR_MOTORS = "https://vmais.app.n8n.cloud/webhook/star-motors-respostas";
const N8N_STAR_AQUECIMENTO = "https://vmais.app.n8n.cloud/webhook/star-aquecimento";
const SUPABASE_URL = "https://tishvpoxekxocyzdiaja.supabase.co";

const PHONE_STAR_MOTORS = "1170154492850086";
const VERIFY_TOKEN_PADRAO = "6ce7d877e49cbfdbfec65de6eafc3ee4e6e4d3861d0df402";

const HEADERS_REPASSADOS = ["content-type", "x-hub-signature", "x-hub-signature-256", "user-agent"];
const TENTATIVAS = 3;
const ESPERA_MS = 4000;
const FALHA_RAPIDA_MS = 8000; // erro antes disso = n8n não processou, pode tentar de novo
// Cloudflare encerra o waitUntil ~30s depois da resposta; 20s cobre a maior
// parte das rajadas (dado de out/26: 436 de 1.391 mensagens vieram <20s da anterior).
const AGRUPAR_MS = 20000;
const JANELA_PENDENTES_MS = 10 * 60 * 1000; // só agrupa mensagens recentes ainda não enviadas

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
      if (!r.ok) console.log(`n8n respondeu ${r.status} em ${url}`);
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

function headersSupabase(env, extra = {}) {
  return {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function gravarNoSupabase(env, linhas) {
  if (!env.SUPABASE_KEY) {
    console.log("SUPABASE_KEY não configurada — mensagens da Star Motors não foram gravadas");
    return false;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/star_motors_mensagens?on_conflict=wamid`, {
      method: "POST",
      headers: headersSupabase(env, { Prefer: "resolution=ignore-duplicates,return=minimal" }),
      body: JSON.stringify(linhas),
    });
    if (!r.ok) console.log(`Supabase respondeu ${r.status}: ${await r.text()}`);
    else console.log(`Supabase: ${linhas.length} mensagem(ns) gravada(s)`);
    return r.ok;
  } catch (e) {
    console.log(`Supabase inalcançável: ${e}`);
    return false;
  }
}

// Chegou mensagem mais nova desse telefone depois desta? Então quem agrupa é ela.
async function temMensagemMaisNova(env, telefone, desde) {
  const q = new URLSearchParams({
    select: "wamid",
    telefone: `eq.${telefone}`,
    recebido_em: `gt.${desde}`,
    limit: "1",
  });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/star_motors_mensagens?${q}`, {
    headers: headersSupabase(env),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return (await r.json()).length > 0;
}

// Marca como enviadas (de forma atômica) as mensagens pendentes do telefone e
// devolve as que ESTA chamada pegou — duas chamadas nunca pegam a mesma linha.
async function pegarPendentes(env, telefone) {
  const desde = new Date(Date.now() - JANELA_PENDENTES_MS).toISOString();
  const q = new URLSearchParams({
    telefone: `eq.${telefone}`,
    enviado_ao_n8n: "is.false",
    recebido_em: `gte.${desde}`,
    select: "wamid,telefone,nome,tipo,texto,raw,recebido_em",
  });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/star_motors_mensagens?${q}`, {
    method: "PATCH",
    headers: headersSupabase(env, { Prefer: "return=representation" }),
    body: JSON.stringify({ enviado_ao_n8n: true }),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const linhas = await r.json();
  return linhas.sort((a, b) => String(a.recebido_em).localeCompare(String(b.recebido_em)));
}

async function desmarcar(env, wamids) {
  if (!wamids.length) return;
  const q = new URLSearchParams({ wamid: `in.(${wamids.map((w) => `"${w}"`).join(",")})` });
  await fetch(`${SUPABASE_URL}/rest/v1/star_motors_mensagens?${q}`, {
    method: "PATCH",
    headers: headersSupabase(env, { Prefer: "return=minimal" }),
    body: JSON.stringify({ enviado_ao_n8n: false }),
  }).catch((e) => console.log(`Supabase inalcançável ao desmarcar: ${e}`));
}

const EH_MIDIA = (tipo) => ["image", "audio", "voice"].includes(tipo);

// Monta os payloads no formato da Meta (o n8n lê messages[0]):
// cada foto/áudio vai sozinho; o resto vira UMA mensagem de texto com as linhas juntas.
function montarPayloadsAgrupados(base, linhas) {
  const envelope = (msg, nome) => ({
    object: base.object || "whatsapp_business_account",
    entry: [{
      id: base.entry?.[0]?.id,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: base.entry?.[0]?.changes?.[0]?.value?.metadata,
          contacts: [{ profile: { name: nome || "" }, wa_id: msg.from }],
          messages: [msg],
        },
      }],
    }],
  });

  const nome = [...linhas].reverse().find((l) => l.nome)?.nome || null;
  const payloads = [];
  const textos = [];
  let ultima = null;
  let referral = null;
  for (const l of linhas) {
    const raw = l.raw || {};
    referral = referral || raw.referral || null;
    if (EH_MIDIA(l.tipo)) {
      payloads.push(envelope(raw, nome));
      // legenda de foto também entra no texto agrupado
      if (raw.image?.caption) textos.push(raw.image.caption);
    } else {
      if (l.texto) textos.push(l.texto);
      ultima = raw;
    }
  }
  if (textos.length > 0) {
    const ref = ultima || linhas[linhas.length - 1].raw || {};
    const msg = {
      from: ref.from || linhas[0].telefone,
      id: ref.id || linhas[linhas.length - 1].wamid,
      timestamp: ref.timestamp,
      type: "text",
      text: { body: textos.join("\n") },
    };
    if (referral) msg.referral = referral;
    payloads.push(envelope(msg, nome));
  }
  return payloads;
}

async function agruparEEnviarAquecimento(env, payloadMsg, telefone, recebidoEm, headers) {
  await new Promise((ok) => setTimeout(ok, AGRUPAR_MS));
  try {
    if (await temMensagemMaisNova(env, telefone, recebidoEm)) {
      console.log(`Aquecimento: ${telefone} mandou mensagem nova — fica pra próxima`);
      return;
    }
    const linhas = await pegarPendentes(env, telefone);
    if (linhas.length === 0) return;
    const payloads = montarPayloadsAgrupados(payloadMsg, linhas);
    console.log(`Aquecimento: ${linhas.length} mensagem(ns) de ${telefone} → ${payloads.length} envio(s)`);
    for (const p of payloads) {
      const ok = await entregarAoN8n(N8N_STAR_AQUECIMENTO, JSON.stringify(p), headers);
      if (!ok) {
        // devolve pra fila; a próxima mensagem do cliente leva junto
        await desmarcar(env, linhas.map((l) => l.wamid));
        return;
      }
    }
  } catch (e) {
    // Supabase fora: não perde a mensagem, manda do jeito antigo (uma por uma)
    console.log(`Agrupamento falhou (${e}) — enviando sem agrupar`);
    await entregarAoN8n(N8N_STAR_AQUECIMENTO, JSON.stringify(payloadMsg), headers);
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

  for (const l of linhas) l.enviado_ao_n8n = false;
  const gravou = await gravarNoSupabase(env, linhas);

  if (temBotao) await entregarAoN8n(N8N_STAR_MOTORS, JSON.stringify(payloadMsg), headers);

  if (!gravou) {
    // sem Supabase não dá pra agrupar: manda direto, como antes
    await entregarAoN8n(N8N_STAR_AQUECIMENTO, JSON.stringify(payloadMsg), headers);
    return;
  }
  const telefone = linhas[linhas.length - 1].telefone;
  const recebidoEm = await recebidoEmDe(env, linhas[linhas.length - 1].wamid);
  await agruparEEnviarAquecimento(env, payloadMsg, telefone, recebidoEm, headers);
}

async function recebidoEmDe(env, wamid) {
  try {
    const q = new URLSearchParams({ select: "recebido_em", wamid: `eq.${wamid}` });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/star_motors_mensagens?${q}`, {
      headers: headersSupabase(env),
    });
    const [l] = await r.json();
    if (l?.recebido_em) return l.recebido_em;
  } catch (e) {}
  return new Date().toISOString();
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

    // Registro de diagnóstico: o que a Meta mandou (sem conteúdo das mensagens).
    for (const entry of payload?.entry || []) {
      for (const change of entry?.changes || []) {
        const v = change?.value || {};
        console.log(JSON.stringify({
          field: change?.field,
          phone_number_id: v.metadata?.phone_number_id,
          numero: v.metadata?.display_phone_number,
          mensagens: (v.messages || []).map((m) => m.type),
          status: (v.statuses || []).map((s) => s.status),
          rota: v.metadata?.phone_number_id === PHONE_STAR_MOTORS ? "star_motors" : "sofist",
        }));
      }
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
