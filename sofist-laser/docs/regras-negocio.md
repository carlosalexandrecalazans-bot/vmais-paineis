# Sofist Laser — Regras de Negócio (IA + Funil + Resgate)

> Documento de referência. Edite aqui em texto simples — depois me diga o que mudou que eu replico no n8n/Supabase/painel.

## 1. Etapas do funil (Kanban/Lista)

| id (interno) | Label no painel | Quando entra | Recebe resgate automático? |
|---|---|---|---|
| `novo` | Novo | Lead chega pela primeira vez | Sim |
| `em_conversa` | **Negociando** | Manual (atendente move) | Não |
| `em_resgate` | Em resgate | Automático, assim que a 1ª mensagem de resgate é enviada | Sim (continua a régua) |
| `rmkt` | Rmkt | Automático, 24h após a última mensagem do lead, se já recebeu o resgate de 23h | Não |
| `aguardando_agenda` | Aguardando agenda | Automático, quando a Sofia aciona handoff tipo `agenda` | Não |
| `agendado` | Agendado | Manual (atendente move) | Não |
| `compareceu` | Compareceu | Manual (atendente move) | Não |
| `venda` | Venda | Manual (atendente move) | Não |
| `perdido` | Perdido | Automático (Sofia identifica desistência) ou manual | Não |

## 2. Régua de resgate automático (mensagens frias)

Roda a cada 30 min, só entre **8h e 20h** (horário de Goiânia). Fora desse horário, fica pendente pro próximo ciclo dentro do horário.

| Quando (desde a última msg do lead) | O quê | Conteúdo |
|---|---|---|
| 1h | Texto | "Oi [nome]! Ainda por aqui? Fico à disposição..." |
| 3h | Texto | "[nome], abriram procura para esse mesmo procedimento. Consigo priorizar você se agendarmos agora." |
| 12h | 4 imagens (só se `procedimento_interesse` contém "Endolaser") | Quebra de objeção: resultado / depoimento / preço / tecnologia |
| 23h | Texto | "Ainda tem interesse, sobrou apenas 1 vaga..." |
| 24h (se 23h já foi enviado) | — (sem mensagem) | Muda etapa pra `rmkt` |

**Não recebe nenhum resgate** se o lead estiver em: `venda`, `perdido`, `rmkt`, `aguardando_agenda`, `em_conversa` (Negociando), ou se tiver uma pausa ativa (`pausar_resgate_ate` no futuro).

Todas as mensagens levam um rodapé com data/hora do envio.

## 3. Pausas de resgate (quando a Sofia NÃO deve insistir)

- **Cliente deu uma data específica** ("na segunda eu falo") → pausa até o fim daquele dia.
- **Cliente adiou sem data** ("agora não", "vou pensar", "preciso ajustar orçamento") → pausa padrão de **3 dias**.
- Nos dois casos, o lead volta pra régua normal automaticamente quando a pausa expira, se ele não retomar contato antes.

## 4. Quando a Sofia passa pra humano (handoff)

| tipo_handoff | Quando aciona | Notifica quem? |
|---|---|---|
| `agenda` | Nome completo + CPF + telefone + procedimento + dia/horário de preferência já coletados | WhatsApp (equipe) + E-mail + grava lead no CRM Belle Software |
| `pedido_humano` | Cliente pede falar com humano, ou pergunta algo fora da tabela de preços | WhatsApp (equipe) |
| `preco` | Cliente tenta negociar/pedir desconto | Nenhuma notificação automática hoje |

A Sofia **continua respondendo normalmente** mesmo depois de um handoff — ela só não some (isso é intencional: só um atendente clicando "Assumir" no painel silencia ela de verdade).

## 5. Procedimentos e preços

- Tabela mestra fica na planilha Google Sheets (97 procedimentos, 5 categorias: Endolaser, Depilação a Laser, Faciais e Injetáveis, Corporal e Capilar, Ultraformer), sincronizada manualmente pra tabela `procedimentos` no Supabase.
- A Sofia responde sobre **qualquer** procedimento da tabela, não só Endolaser/Depilação a Laser.
- Se perguntarem algo que não está na tabela, ela aciona `pedido_humano`.

## 6. Painel do atendente

- **Kanban** e **Lista**: ambos com menu "Mover p/…" pra trocar etapa manualmente.
- Badge **🤖 IA** / **🙋 Humano** em cada card/linha, mostrando quem está respondendo aquele lead agora.
- Botão **🙋 Assumir**: atendente assume a conversa, Sofia para de responder esse lead.
- Botão **🤖 Devolver pra IA**: devolve o controle pra Sofia.
- Botão **📷** no chat: envia foto manual (link de imagem + legenda) pro lead.
- Filtro por etapa + busca por nome/telefone no topo do funil.

## 7. Integrações externas

- **WhatsApp**: API oficial da Meta (Cloud API), número dedicado da Sofist Laser.
- **Belle Software (CRM)**: endpoint `cliente/gravar` grava o lead automaticamente no handoff de agenda (nome, telefone, CPF, procedimento, observação). Token de integração fixo por estabelecimento (`codEstab: 1`).
- **Agendamento real**: continua manual — a equipe finaliza no Belle Software depois de receber a notificação.

---
*Última atualização: 18/09/2026*
