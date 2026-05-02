# 🪵 Stilus Planejados — Backend

Site completo com Node.js + Express + PostgreSQL + Painel Admin.

---

## 📁 Estrutura

```
stilus-backend/
├── public/
│   ├── index.html        ← Site principal
│   └── uploads/          ← Imagens enviadas pelo admin
├── src/
│   ├── server.js         ← Servidor principal
│   ├── db.js             ← Banco de dados (PostgreSQL)
│   ├── routes.js         ← Todas as rotas
│   ├── auth.js           ← Middleware de autenticação
│   └── upload.js         ← Configuração de uploads
├── .env.example          ← Copie para .env e preencha
├── package.json
└── README.md
```

---

## 🚀 Como subir no Railway

### 1. Criar conta e projeto

1. Acesse [railway.app](https://railway.app) e crie uma conta (GitHub recomendado)
2. Clique em **New Project**
3. Escolha **Deploy from GitHub repo** e selecione seu repositório

### 2. Adicionar banco PostgreSQL

1. No projeto Railway, clique em **+ New Service**
2. Escolha **Database → PostgreSQL**
3. Clique no banco criado e vá em **Variables**
4. Copie o valor de `DATABASE_URL`

### 3. Configurar variáveis de ambiente

No serviço do seu app (Node.js), vá em **Variables** e adicione:

```
DATABASE_URL=postgresql://...  ← cole o valor copiado do banco
SESSION_SECRET=qualquer_string_longa_e_aleatoria_aqui
ADMIN_USERNAME=admin
ADMIN_PASSWORD=sua_senha_segura
NODE_ENV=production
```

### 4. Deploy

O Railway faz deploy automático a cada push no GitHub. ✅

---

## 🖥️ Rodando localmente

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis
cp .env.example .env
# Edite o .env com seus dados

# 3. Iniciar (requer PostgreSQL local ou Railway)
npm run dev
```

Acesse: http://localhost:3000
Admin: http://localhost:3000/admin

---

## 🔐 Painel Admin

**URL:** `/admin`

**Login padrão** (altere nas variáveis de ambiente):
- Usuário: `admin`
- Senha: `admin123`

### O que você pode fazer no admin:

| Funcionalidade | Descrição |
|---|---|
| 🖼️ **Upload de imagens** | Envie múltiplas fotos de uma vez |
| 📂 **Categorias** | cozinha, quarto, closet, banheiro, escritório |
| 📍 **Seções** | hero, sobre, portfolio, categorias |
| ⭐ **Destaque** | Marque imagens para aparecer em posições especiais |
| 🔢 **Ordem** | Controle a ordem de exibição |
| 📋 **Orçamentos** | Veja todos os pedidos recebidos pelo site |
| 🔗 **WhatsApp** | Clique no telefone do orçamento para abrir o WhatsApp |

---

## 🌐 Endpoints da API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/imagens` | Lista imagens (filtre por `?secao=portfolio&categoria=cozinha`) |
| POST | `/api/orcamento` | Salva orçamento no banco |

---

## ⚠️ Antes de publicar

1. **Número do WhatsApp** — edite `public/index.html` e troque `5532999990000` pelo número real
2. **Admin password** — sempre defina `ADMIN_PASSWORD` no Railway (nunca use o padrão em produção)
3. **Session secret** — use uma string longa e aleatória em `SESSION_SECRET`
