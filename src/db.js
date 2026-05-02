const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS imagens (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(200) NOT NULL,
        descricao TEXT,
        categoria VARCHAR(100) NOT NULL DEFAULT 'geral',
        filename VARCHAR(300) NOT NULL,
        url VARCHAR(500) NOT NULL,
        destaque BOOLEAN DEFAULT false,
        secao VARCHAR(100) DEFAULT 'portfolio',
        ordem INT DEFAULT 0,
        criado_em TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orcamentos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(200) NOT NULL,
        telefone VARCHAR(50),
        tipo VARCHAR(100),
        ambiente VARCHAR(200),
        mensagem TEXT,
        lido BOOLEAN DEFAULT false,
        criado_em TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_usuarios (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(200) NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Banco de dados inicializado com sucesso');
  } catch (err) {
    console.error('❌ Erro ao inicializar banco:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
