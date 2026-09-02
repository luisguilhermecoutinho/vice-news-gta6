# Backend VIP automático — Guia de Ativação (100% grátis)

Objetivo: cliente paga no Stripe → recebe **email com código único** → mete o código no site → fica VIP. Código **só funciona uma vez** (a nível global).

Peças (todas em plano gratuito): **Cloudflare Worker + KV** (servidor) · **Resend** (email) · **Stripe webhook** (aviso de pagamento).

O ficheiro do servidor é o **`vip-worker.js`** (já criado).

---

## Passo 1 — Resend (envio de emails) · grátis
1. Cria conta em **https://resend.com** (grátis, 3.000 emails/mês).
2. Em **Domains → Add Domain**, adiciona **vicenewsgta6.com**.
3. O Resend dá-te uns registos DNS (TXT/MX). Adiciona-os no **Cloudflare → DNS** do `vicenewsgta6.com` (Add record, copia o que o Resend mostrar). Espera a verificação ficar verde.
4. Em **API Keys → Create**, cria uma chave e **guarda-a** (vais precisar dela no Passo 3). Começa por `re_...`.

> Enquanto o domínio não estiver verificado, podes testar com remetente `onboarding@resend.dev` (só envia para o teu próprio email).

## Passo 2 — Cloudflare: KV + Worker
1. No Cloudflare → **Storage & Databases → KV → Create namespace**: nome `vip-codes`.
2. **Compute → Workers & Pages → Create → Worker**. Nome: `vice-news-vip`. Deploy do exemplo.
3. Abre o Worker → **Edit code**, apaga tudo e **cola o conteúdo do `vip-worker.js`**. Deploy.
4. No Worker → **Settings → Variables and Bindings**:
   - **KV namespace binding**: Variable name = `VIP` → liga ao namespace `vip-codes`.
   - **Variables (texto)**: `FROM_EMAIL` = `Vice News <vip@vicenewsgta6.com>` (ou `onboarding@resend.dev` para testes).
   - **Secrets (encriptados)** — *tens de ser tu a colá-los*:
     - `RESEND_API_KEY` = a chave do Resend (Passo 1).
     - `STRIPE_WEBHOOK_SECRET` = vais obter no Passo 3.
5. Copia o **URL do Worker** (ex.: `https://vice-news-vip.<algo>.workers.dev`).

## Passo 3 — Stripe webhook
1. No **Stripe (modo Live) → Developers → Webhooks → Add endpoint**.
2. Endpoint URL = `<URL do teu Worker>/webhook`
3. Evento a escutar: **`checkout.session.completed`**.
4. Cria. O Stripe mostra um **Signing secret** (`whsec_...`) → copia-o e mete-o no Worker como secret `STRIPE_WEBHOOK_SECRET` (Passo 2.4) e faz Deploy.

## Passo 4 — Ligar o site ao Worker
1. Diz-me o **URL do Worker** que copiaste no Passo 2.5.
2. Eu coloco-o no site (variável `WORKER_URL`) e republico no GitHub.
3. A partir daí, o resgate de código passa a ser validado pelo servidor (uso único global) e funciona em qualquer dispositivo.

---

## Como fica o fluxo final
1. Cliente clica **Subscrever ★** → paga no Stripe.
2. Stripe avisa o Worker → o Worker **gera um código**, guarda-o e **envia o email** ao cliente.
3. Cliente vai ao site → conta → **Ativar código VIP** → mete o código → **VIP ativado**.
4. O código fica **usado** e não pode ser reutilizado.

## Notas
- Tudo isto cabe nos planos **gratuitos**.
- As partes com **chaves secretas** (Resend key, Stripe secret) tens de as colar tu — eu não introduzo segredos.
- Os 30 códigos manuais (`codigos-vip.txt`) continuam a funcionar como reserva enquanto o `WORKER_URL` estiver vazio; depois de ligares o Worker, os códigos passam a ser os gerados nas compras.
