require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDB, pool } = require('./db');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Necessário para cookies funcionarem atrás do proxy do Railway
app.set('trust proxy', 1);

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Sessão com PostgreSQL store em produção
let sessionStore;
try {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({ pool, tableName: 'sessoes', createTableIfMissing: true });
} catch {
  sessionStore = undefined;
}

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'stilus_secret_2025_xk9z',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24h
  },
}));

// ─── ROTAS ────────────────────────────────────────────────────────────────────
app.use('/', routes);

// Serve o site (index.html) para todas as rotas não-admin e não-api
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── INICIALIZAÇÃO ────────────────────────────────────────────────────────────
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`\n🪵 Stilus Planejados rodando em http://localhost:${PORT}`);
    console.log(`🔐 Painel Admin: http://localhost:${PORT}/admin`);
    console.log(`   Usuário: ${process.env.ADMIN_USERNAME || 'admin'}`);
    console.log(`   Senha:   ${process.env.ADMIN_PASSWORD ? '(definida no .env)' : 'admin123 (padrão)'}\n`);
  });
}

start().catch(err => {
  console.error('❌ Erro ao iniciar servidor:', err);
  process.exit(1);
});
