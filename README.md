# Barbearia Marques – app + backend

Servidor Node.js sem dependências (só Node 22.5 ou mais novo). Banco SQLite em arquivo.
O mesmo servidor entrega o app (pasta `public/`) e a API (`/api/...`).

## Rodar no seu computador
```bash
ADMIN_PASSWORD=minhasenha SECRET=um-texto-longo-aleatorio npm start
```
Abra http://localhost:3000. No Windows (PowerShell):
```powershell
$env:ADMIN_PASSWORD="minhasenha"; $env:SECRET="um-texto-longo-aleatorio"; npm start
```
A aba **Painel** pede a senha definida em `ADMIN_PASSWORD`.

## Colocar no ar (Render, Railway ou Fly.io)
1. Suba esta pasta para um repositório no GitHub.
2. Crie um serviço web (Node, ou use o `Dockerfile`). Comando de início: `npm start`.
3. Defina as variáveis: `ADMIN_PASSWORD`, `SECRET` (texto longo aleatório).
4. **Importante:** o SQLite é um arquivo. Anexe um disco persistente e aponte `DB_PATH` para ele
   (ex.: `/data/marques.db`). Sem disco, os agendamentos somem a cada deploy.
5. Use sempre HTTPS (a plataforma já fornece).

## Variáveis de ambiente
| Variável | Para que serve |
|---|---|
| `ADMIN_PASSWORD` | Senha do painel do barbeiro (obrigatório trocar) |
| `SECRET` | Chave que assina o login do painel (obrigatório definir) |
| `DB_PATH` | Caminho do arquivo do banco |
| `PORT` | Porta (as plataformas definem sozinhas) |
| `ALLOWED_ORIGIN` | Origem permitida (CORS). Padrão `*` |

## Serviços, preços, barbeiros e horários
Edite o topo de `server.js` (`SERVICES`, `BARBERS`, `HOURS`) **e** as mesmas listas
no começo do script de `public/index.html` (`SERV`, `BARB`, `HORAS`). O servidor é quem
vale para preço e validação.

## App Android/iOS (Capacitor)
Em `public/index.html`, troque `window.API_BASE=""` pela URL do servidor,
por exemplo `"https://marques.onrender.com"`, e rode `npx cap sync`.

## API
- `GET  /api/slots?day=AAAA-MM-DD&barber=Nome` – horários ocupados
- `POST /api/bookings` – cria agendamento (devolve `id` e `token` para cancelar)
- `DELETE /api/bookings/:id?token=...` – cliente cancela
- `POST /api/admin/login` – devolve token de 12 h
- `GET  /api/admin/bookings` – agenda (exige `Authorization: Bearer <token>`)
- `DELETE /api/admin/bookings/:id` – barbeiro cancela ou libera bloqueio
- `POST /api/admin/block` – bloqueia horário

## Segurança já incluída
Horário único por barbeiro (o banco impede reserva dupla), validação de tudo no servidor,
limite de tentativas no login e na criação de agendamentos, login do painel com token assinado,
cancelamento do cliente só com o token do próprio agendamento.

## Lembre-se
- Política de privacidade é obrigatória nas lojas (o app guarda nome e telefone).
- Faça backup do arquivo `marques.db` de vez em quando.
