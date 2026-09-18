# Sofist Laser — Changelog da sessão (18/09/2026)

Registro do que foi construído/corrigido nesta sessão, pra consulta futura.

## Resgate automático (workflow n8n "Resgate automático de leads frios")
- Adicionado estágio de 12h com 4 imagens de quebra de objeção (só Endolaser)
- Restaurado estágio de 3h que tinha sido removido por engano
- Adicionada janela de horário comercial (8h-20h, Goiânia)
- Adicionado rodapé de data/hora em todas as mensagens
- Adicionadas etapas `aguardando_agenda` e `em_conversa` à lista de exclusão do resgate
- **Bug corrigido**: parsing de data do `pausar_resgate_ate` quebrava silenciosamente (formato do Supabase não era reconhecido pelo JS) — pausas não estavam sendo respeitadas
- **Bug corrigido**: trava do estágio de 12h usava `produto_interesse` (legenda do anúncio) em vez do procedimento real identificado pela Sofia
- `etapa_funil` agora vira `em_resgate` desde o 1º estágio de resgate, não só no de 23h

## Sofia (workflow n8n "Agente IA - Atendimento Endolaser")
- Expandida pra responder sobre todos os 97 procedimentos (5 categorias), não só Endolaser/Depilação a Laser
- Adicionada coleta de dia/horário de preferência antes do handoff de agenda
- Adicionados campos estruturados: `cpf_identificado`, `procedimento_interesse`
- Notificação de handoff de agenda: WhatsApp + E-mail + gravação automática no CRM Belle Software (endpoint `cliente/gravar`)
- Handoff `pedido_humano` também notifica por WhatsApp (além de `agenda`)
- Handoff automático não silencia mais a IA permanentemente — só o botão manual "Assumir" no painel faz isso
- Nova regra: adiamento sem data específica ("vou pensar", "agora não") ganha pausa padrão de 3 dias

## Banco de dados (Supabase)
- Nova coluna `procedimento_interesse` na tabela `leads`
- Importados 47 procedimentos que faltavam (Faciais/Injetáveis, Corporal e Capilar, Ultraformer) — total 97
- Backfill de `procedimento_interesse` pra 36 leads ativos que já mencionavam Endolaser na conversa

## Painel do atendente (GitHub Pages)
- Menu "Mover p/…" também na visão em Lista (antes só no Kanban)
- Ajuste de layout mobile (nomes longos truncam, linha mais compacta)
- Botão "🙋 Assumir" (silencia a Sofia manualmente), complementar ao "Devolver pra IA"
- Badge 🤖 IA / 🙋 Humano sempre visível em cada lead (Kanban e Lista)
- Botão 📷 no chat pra envio manual de foto (link + legenda)
- Filtro por etapa + busca por nome/telefone
- Renomeado label "Em conversa" → "Negociando"

## Integrações
- Confirmada API real do Belle Software (`cliente/gravar`) — documentação obtida via suporte@geinfo.com.br
- Endpoint `funil-assumir-humano` (marca atendimento manual)
- Endpoint `funil-enviar-midia` (envio manual de foto)

## Pendências / decisões em aberto
- Número de notificação de agenda ainda apontando pro número de teste (62 99193-7090) — trocar de volta pro 62 9371-6862 quando confirmar que está tudo certo
- Token da API Belle Software é idêntico ao da Agenda Online pública — validar com um teste real se funciona pra gravação de cliente
- WhatsApp em grupo via Evolution API: avaliado, mas não implementado — decisão pendente sobre qual número usar
