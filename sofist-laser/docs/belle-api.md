# Belle Software — API de Integração Externa (resumo)

Documentação completa (Postman): https://documenter.getpostman.com/view/12548729/UzJHRHyh
Base: `https://app.bellesoftware.com.br/api/release/controller/IntegracaoExterna/v1.0`
Autenticação: cabeçalho `Authorization: <token do estabelecimento>`. Estabelecimento Sofist: `codEstab = 1` (ticket Belle #96555, unidade 142097).

**Bloqueio de IP:** a Belle bloqueia IPs internacionais. O n8n Cloud sai por `4.184.78.255` (Frankfurt, DE) — liberação pedida no ticket #96555 em 29/09/2026. Enquanto não liberar, toda chamada volta `403 Forbidden`.

## Endpoints que interessam pra Sofia

| Uso | Método e rota | Observação |
|---|---|---|
| Cadastrar cliente | `POST /cliente/gravar` | nome, ddiCelular, celular, email, cpf, observacao, tpOrigem, codOrigem, codEstab. Retorna o código do cliente. |
| Cadastrar **lead** | `POST /cliente/gravar-lead` | Igual ao de cliente, mas CPF/e-mail podem ir vazios — serve pra registrar todo lead do anúncio logo no 1º contato. |
| Buscar cliente | `GET /cliente/listar?cpf=&id=&codEstab=&email=&celular=` | Evita cadastro duplicado. |
| Listar serviços | `GET /servico/listar?codPlano=&codProf=&codSala=&filtro=&codCategoria=&codTipo=` | Traz `codServico`, `nome`, `tempo` — necessários pra agendar. |
| **Horários disponíveis** | `GET /agenda/disponibilidade?codEstab=&dtAgenda=&periodo=&servicos=&tpAgd=` | Todos obrigatórios. Retorna a semana da data informada, com os horários livres por sala/profissional. |
| **Gravar agendamento** | `POST /agenda/gravar` | codCli, codEstab, dtAgd (dd/mm/aaaa), hri (hh:mm), serv[] (de /servico/listar), agSala + codSala (agenda por sala) ou prof (por profissional), observacao. Valida choque de horário. |
| **Alterar status** | `PUT /agenda/status` | `{ codConsulta, novoStatus }` — Confirmado, Cancelado, Desmarcado, Falhou, Aguardando. Só funciona em agendamento "em aberto". |
| Tipos de agendamento | `GET /agenda/tipos_agendamento` | Valor pro `tpAgd` da disponibilidade. |
| Profissionais | `GET /usuario/listar?codEstab=&possuiAgenda=1` | |
| CRM (funis) | `GET /crm/funis?codEstab=` · `GET /crm/funil/clientes?codFunil=` | |

## Como isso casa com a regra de pré-reserva

1. Sofia consulta `/agenda/disponibilidade` e só oferece horários livres na sala do procedimento (ex.: "Lavieen / Endolaser", "Sala Laser").
2. Com nome + CPF, cadastra/acha o cliente e grava o agendamento com `/agenda/gravar` — ele entra **em aberto** (= pré-reserva) na agenda.
3. A equipe confirma na própria agenda do Belle (ou por um botão no painel que chama `/agenda/status` com `Confirmado`). A Sofia continua dizendo ao cliente que é pré-reserva até a confirmação.
