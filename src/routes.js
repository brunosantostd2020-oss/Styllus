const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('./db');
const { requireAuth } = require('./auth');
const upload = require('./upload');

// ─── API PÚBLICA ─────────────────────────────────────────────────────────────

// Buscar imagens para o site (por seção ou categoria)
router.get('/api/imagens', async (req, res) => {
  try {
    const { secao, categoria, destaque } = req.query;
    let query = 'SELECT * FROM imagens WHERE 1=1';
    const params = [];
    if (secao) { params.push(secao); query += ` AND secao = $${params.length}`; }
    if (categoria) { params.push(categoria); query += ` AND categoria = $${params.length}`; }
    if (destaque === 'true') query += ' AND destaque = true';
    query += ' ORDER BY ordem ASC, criado_em DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Receber orçamento do formulário do site
router.post('/api/orcamento', async (req, res) => {
  try {
    const { nome, telefone, tipo, ambiente, mensagem } = req.body;
    if (!nome || !ambiente) return res.status(400).json({ erro: 'Nome e ambiente são obrigatórios' });
    await pool.query(
      'INSERT INTO orcamentos (nome, telefone, tipo, ambiente, mensagem) VALUES ($1,$2,$3,$4,$5)',
      [nome, telefone || null, tipo || null, ambiente, mensagem || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── PAINEL ADMIN ─────────────────────────────────────────────────────────────

// Login
router.get('/admin/login', (req, res) => {
  if (req.session.adminLogado) return res.redirect('/admin');
  res.send(renderLogin());
});

router.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  try {
    // Verifica usuário do banco primeiro
    const { rows } = await pool.query('SELECT * FROM admin_usuarios WHERE username = $1', [username]);
    let ok = false;
    if (rows.length > 0) {
      ok = await bcrypt.compare(password, rows[0].password_hash);
    } else if (username === adminUser && password === adminPass) {
      ok = true;
    }
    if (ok) {
      req.session.adminLogado = true;
      req.session.adminUser = username;
      return res.redirect('/admin');
    }
    res.send(renderLogin('Usuário ou senha incorretos.'));
  } catch (err) {
    res.send(renderLogin('Erro: ' + err.message));
  }
});

router.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Dashboard Admin
router.get('/admin', requireAuth, async (req, res) => {
  try {
    const imgs = await pool.query('SELECT COUNT(*) FROM imagens');
    const orcamentos = await pool.query('SELECT COUNT(*) FROM orcamentos');
    const naoLidos = await pool.query('SELECT COUNT(*) FROM orcamentos WHERE lido = false');
    res.send(renderDashboard({
      totalImagens: imgs.rows[0].count,
      totalOrcamentos: orcamentos.rows[0].count,
      naoLidos: naoLidos.rows[0].count,
      user: req.session.adminUser,
    }));
  } catch (err) {
    res.send('<p>Erro: ' + err.message + '</p>');
  }
});

// Listar imagens
router.get('/admin/imagens', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM imagens ORDER BY criado_em DESC');
    res.send(renderImagens(rows));
  } catch (err) {
    res.send('<p>Erro: ' + err.message + '</p>');
  }
});

// Upload nova imagem
router.post('/admin/imagens/upload', requireAuth, upload.array('fotos', 20), async (req, res) => {
  try {
    const { titulo, descricao, categoria, secao, destaque, ordem } = req.body;
    const files = req.files || [];
    if (files.length === 0) return res.redirect('/admin/imagens?erro=Nenhum arquivo enviado');
    for (const file of files) {
      const url = `/uploads/${file.filename}`;
      await pool.query(
        'INSERT INTO imagens (titulo, descricao, categoria, secao, filename, url, destaque, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [titulo || file.originalname, descricao || '', categoria || 'geral', secao || 'portfolio', file.filename, url, destaque === 'on', parseInt(ordem) || 0]
      );
    }
    res.redirect('/admin/imagens?ok=Imagens enviadas com sucesso!');
  } catch (err) {
    res.redirect('/admin/imagens?erro=' + encodeURIComponent(err.message));
  }
});

// Editar imagem
router.post('/admin/imagens/:id/editar', requireAuth, async (req, res) => {
  const { titulo, descricao, categoria, secao, destaque, ordem } = req.body;
  await pool.query(
    'UPDATE imagens SET titulo=$1, descricao=$2, categoria=$3, secao=$4, destaque=$5, ordem=$6 WHERE id=$7',
    [titulo, descricao, categoria, secao, destaque === 'on', parseInt(ordem) || 0, req.params.id]
  );
  res.redirect('/admin/imagens?ok=Imagem atualizada!');
});

// Deletar imagem
router.post('/admin/imagens/:id/deletar', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename FROM imagens WHERE id=$1', [req.params.id]);
    if (rows.length > 0) {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(__dirname, '../public/uploads', rows[0].filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await pool.query('DELETE FROM imagens WHERE id=$1', [req.params.id]);
    res.redirect('/admin/imagens?ok=Imagem deletada.');
  } catch (err) {
    res.redirect('/admin/imagens?erro=' + encodeURIComponent(err.message));
  }
});

// Listar orçamentos
router.get('/admin/orcamentos', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orcamentos ORDER BY criado_em DESC');
    // Marcar todos como lidos
    await pool.query('UPDATE orcamentos SET lido=true WHERE lido=false');
    res.send(renderOrcamentos(rows));
  } catch (err) {
    res.send('<p>Erro: ' + err.message + '</p>');
  }
});

// Deletar orçamento
router.post('/admin/orcamentos/:id/deletar', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM orcamentos WHERE id=$1', [req.params.id]);
  res.redirect('/admin/orcamentos?ok=Orçamento removido.');
});

// ─── HELPERS DE RENDERIZAÇÃO ──────────────────────────────────────────────────

function layout(titulo, conteudo, user = '') {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} — Stilus Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;display:flex}
  .sidebar{width:220px;background:#1a1a1a;border-right:1px solid #2a2a2a;display:flex;flex-direction:column;padding:1.5rem 0;flex-shrink:0;min-height:100vh}
  .sidebar-logo{padding:0 1.5rem 1.5rem;border-bottom:1px solid #2a2a2a;margin-bottom:1rem}
  .sidebar-logo h2{color:#E8000D;font-size:1.1rem;font-weight:700}
  .sidebar-logo p{color:#888;font-size:0.7rem;margin-top:2px}
  .sidebar a{display:block;padding:0.75rem 1.5rem;color:#aaa;text-decoration:none;font-size:0.82rem;transition:all 0.2s;border-left:3px solid transparent}
  .sidebar a:hover,.sidebar a.active{color:#fff;background:#222;border-left-color:#E8000D}
  .sidebar-footer{margin-top:auto;padding:1rem 1.5rem;border-top:1px solid #2a2a2a}
  .sidebar-footer a{color:#666;font-size:0.75rem;text-decoration:none}
  .sidebar-footer a:hover{color:#E8000D}
  .main{flex:1;padding:2rem;overflow-x:auto}
  .page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem}
  .page-header h1{font-size:1.4rem;font-weight:600}
  .page-header small{color:#888;font-size:0.78rem}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem}
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem}
  .stat-card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:1.2rem;text-align:center}
  .stat-num{font-size:2.2rem;font-weight:700;color:#E8000D;display:block}
  .stat-label{font-size:0.75rem;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:.05em}
  .btn{display:inline-block;padding:0.6rem 1.2rem;border:none;border-radius:4px;font-size:0.82rem;cursor:pointer;text-decoration:none;transition:all .2s}
  .btn-red{background:#E8000D;color:#fff}.btn-red:hover{background:#B50009}
  .btn-gray{background:#2a2a2a;color:#ccc;border:1px solid #444}.btn-gray:hover{background:#333}
  .btn-sm{padding:0.35rem 0.8rem;font-size:0.75rem}
  .btn-danger{background:#7a1a1a;color:#fff;border:none}.btn-danger:hover{background:#9a2020}
  table{width:100%;border-collapse:collapse;font-size:0.83rem}
  th{text-align:left;padding:0.75rem;color:#888;font-weight:500;border-bottom:1px solid #2a2a2a;font-size:0.72rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:0.75rem;border-bottom:1px solid #1e1e1e;vertical-align:middle}
  tr:hover td{background:rgba(255,255,255,.02)}
  .badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:0.7rem;font-weight:600}
  .badge-red{background:rgba(232,0,13,.15);color:#E8000D}
  .badge-gray{background:rgba(255,255,255,.07);color:#aaa}
  .badge-green{background:rgba(37,211,102,.15);color:#25D366}
  input,select,textarea{background:#111;border:1px solid #333;color:#e0e0e0;padding:0.6rem 0.85rem;border-radius:4px;font-size:0.85rem;width:100%}
  input:focus,select:focus,textarea:focus{outline:none;border-color:#E8000D}
  label{display:block;font-size:0.78rem;color:#aaa;margin-bottom:0.4rem;margin-top:1rem}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
  .alert{padding:0.75rem 1rem;border-radius:4px;margin-bottom:1rem;font-size:0.83rem}
  .alert-ok{background:rgba(37,211,102,.1);border:1px solid rgba(37,211,102,.2);color:#25D366}
  .alert-erro{background:rgba(232,0,13,.1);border:1px solid rgba(232,0,13,.2);color:#E8000D}
  .img-thumb{width:60px;height:50px;object-fit:cover;border-radius:4px;border:1px solid #333}
  .upload-area{border:2px dashed #333;border-radius:8px;padding:2rem;text-align:center;cursor:pointer;transition:.2s}
  .upload-area:hover{border-color:#E8000D;background:rgba(232,0,13,.03)}
  .upload-area input[type=file]{display:none}
  @media(max-width:768px){.sidebar{width:60px}.sidebar a span,.sidebar-logo p,.sidebar-logo h2,.sidebar-footer{display:none}.sidebar a{padding:.75rem;text-align:center}.form-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="sidebar">
  <div class="sidebar-logo"><h2>🪵 Stilus</h2><p>Admin Panel</p></div>
  <a href="/admin">🏠 <span>Dashboard</span></a>
  <a href="/admin/imagens">🖼️ <span>Imagens</span></a>
  <a href="/admin/orcamentos">📋 <span>Orçamentos</span></a>
  <div class="sidebar-footer"><a href="/admin/logout">🚪 <span>Sair (${user})</span></a></div>
</div>
<div class="main">${conteudo}</div>
</body>
</html>`;
}

function renderLogin(erro = '') {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login — Stilus</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .box{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:2.5rem;width:360px}
  h1{font-size:1.3rem;margin-bottom:0.3rem;color:#fff}
  p.sub{font-size:0.8rem;color:#888;margin-bottom:1.8rem}
  label{display:block;font-size:0.78rem;color:#aaa;margin-bottom:.4rem;margin-top:1rem}
  input{background:#111;border:1px solid #333;color:#e0e0e0;padding:0.7rem 1rem;border-radius:4px;font-size:0.88rem;width:100%}
  input:focus{outline:none;border-color:#E8000D}
  button{width:100%;background:#E8000D;color:#fff;border:none;padding:0.75rem;border-radius:4px;font-size:0.88rem;cursor:pointer;margin-top:1.5rem;font-weight:600}
  button:hover{background:#B50009}
  .err{background:rgba(232,0,13,.1);border:1px solid rgba(232,0,13,.2);color:#E8000D;padding:.6rem .9rem;border-radius:4px;font-size:.8rem;margin-top:1rem}
  .logo{color:#E8000D;font-size:1.8rem;margin-bottom:1rem}
</style>
</head>
<body>
<div class="box">
  <div class="logo">🪵</div>
  <h1>Painel Admin</h1>
  <p class="sub">Stilus Planejados — Cataguases MG</p>
  <form method="POST" action="/admin/login">
    <label>Usuário</label>
    <input type="text" name="username" required autocomplete="username">
    <label>Senha</label>
    <input type="password" name="password" required autocomplete="current-password">
    <button type="submit">Entrar</button>
    ${erro ? `<div class="err">${erro}</div>` : ''}
  </form>
</div>
</body>
</html>`;
}

function renderDashboard({ totalImagens, totalOrcamentos, naoLidos, user }) {
  return layout('Dashboard', `
    <div class="page-header">
      <div><h1>Dashboard</h1><small>Bem-vindo, ${user}</small></div>
      <a href="/" target="_blank" class="btn btn-gray">Ver Site ↗</a>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><span class="stat-num">${totalImagens}</span><span class="stat-label">Imagens</span></div>
      <div class="stat-card"><span class="stat-num">${totalOrcamentos}</span><span class="stat-label">Orçamentos</span></div>
      <div class="stat-card"><span class="stat-num" style="color:#25D366">${naoLidos}</span><span class="stat-label">Não Lidos</span></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:1rem;font-size:1rem">Ações Rápidas</h3>
      <a href="/admin/imagens" class="btn btn-red" style="margin-right:.5rem">🖼️ Gerenciar Imagens</a>
      <a href="/admin/orcamentos" class="btn btn-gray">📋 Ver Orçamentos</a>
    </div>
    <div class="card">
      <h3 style="font-size:.9rem;color:#888;margin-bottom:.75rem">💡 Dica</h3>
      <p style="font-size:.82rem;color:#666;line-height:1.7">
        As imagens que você enviar aqui aparecerão automaticamente no site.<br>
        Defina a <strong style="color:#aaa">seção</strong> (hero, sobre, portfolio, categorias) e a <strong style="color:#aaa">categoria</strong> (cozinha, quarto, closet, etc.) para organizar corretamente.
      </p>
    </div>
  `, user);
}

function renderImagens(rows) {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const categorias = ['geral', 'cozinha', 'quarto', 'closet', 'banheiro', 'escritorio', 'sala'];
  const secoes = ['hero', 'sobre', 'portfolio', 'categorias'];

  const tabela = rows.length === 0
    ? '<p style="color:#888;text-align:center;padding:2rem">Nenhuma imagem cadastrada ainda.</p>'
    : `<table>
      <tr><th>Imagem</th><th>Título</th><th>Categoria</th><th>Seção</th><th>Destaque</th><th>Ordem</th><th>Ações</th></tr>
      ${rows.map(img => `
      <tr>
        <td><img class="img-thumb" src="${img.url}" alt="${img.titulo}" onerror="this.style.opacity='.3'"></td>
        <td>${img.titulo}</td>
        <td><span class="badge badge-red">${img.categoria}</span></td>
        <td><span class="badge badge-gray">${img.secao}</span></td>
        <td>${img.destaque ? '<span class="badge badge-green">Sim</span>' : '<span class="badge badge-gray">Não</span>'}</td>
        <td>${img.ordem}</td>
        <td>
          <button onclick="abrirEditar(${img.id},'${img.titulo}','${img.descricao || ''}','${img.categoria}','${img.secao}',${img.destaque},${img.ordem})" class="btn btn-gray btn-sm">✏️</button>
          <form method="POST" action="/admin/imagens/${img.id}/deletar" style="display:inline" onsubmit="return confirm('Deletar esta imagem?')">
            <button type="submit" class="btn btn-danger btn-sm">🗑️</button>
          </form>
        </td>
      </tr>`).join('')}
    </table>`;

  return layout('Imagens', `
    <div class="page-header"><h1>🖼️ Imagens</h1></div>

    <div class="card">
      <h3 style="margin-bottom:1.2rem;font-size:1rem">📤 Enviar Novas Imagens</h3>
      <form method="POST" action="/admin/imagens/upload" enctype="multipart/form-data">
        <div class="upload-area" onclick="document.getElementById('fInput').click()">
          <input id="fInput" type="file" name="fotos" accept="image/*" multiple onchange="mostrarArquivos(this)">
          <div id="uploadLabel">
            <p style="font-size:2rem">📁</p>
            <p style="margin-top:.5rem;color:#aaa">Clique para selecionar imagens</p>
            <p style="font-size:.75rem;color:#666;margin-top:.3rem">JPG, PNG, WEBP · até 8MB cada · múltiplos arquivos</p>
          </div>
        </div>
        <div class="form-row">
          <div>
            <label>Título</label>
            <input type="text" name="titulo" placeholder="Ex: Cozinha Moderna Branca">
          </div>
          <div>
            <label>Ordem (menor = primeiro)</label>
            <input type="number" name="ordem" value="0" min="0">
          </div>
        </div>
        <div class="form-row">
          <div>
            <label>Categoria</label>
            <select name="categoria">
              ${categorias.map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Seção do site</label>
            <select name="secao">
              ${secoes.map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
            </select>
          </div>
        </div>
        <label>Descrição (opcional)</label>
        <textarea name="descricao" rows="2" placeholder="Breve descrição..."></textarea>
        <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-top:1rem">
          <input type="checkbox" name="destaque" style="width:auto"> Imagem em destaque
        </label>
        <button type="submit" class="btn btn-red" style="margin-top:1.2rem;width:100%">📤 Enviar Imagens</button>
      </form>
    </div>

    <div class="card">
      <h3 style="margin-bottom:1.2rem;font-size:1rem">📋 Imagens Cadastradas (${rows.length})</h3>
      ${tabela}
    </div>

    <!-- Modal editar -->
    <div id="modalEditar" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:999;align-items:center;justify-content:center">
      <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:2rem;width:500px;max-width:95vw">
        <h3 style="margin-bottom:1rem">✏️ Editar Imagem</h3>
        <form id="formEditar" method="POST">
          <div class="form-row">
            <div><label>Título</label><input type="text" name="titulo" id="eTitulo"></div>
            <div><label>Ordem</label><input type="number" name="ordem" id="eOrdem" min="0"></div>
          </div>
          <div class="form-row">
            <div>
              <label>Categoria</label>
              <select name="categoria" id="eCategoria">
                ${categorias.map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Seção</label>
              <select name="secao" id="eSecao">
                ${secoes.map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
              </select>
            </div>
          </div>
          <label>Descrição</label>
          <textarea name="descricao" id="eDescricao" rows="2"></textarea>
          <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-top:1rem">
            <input type="checkbox" name="destaque" id="eDestaque" style="width:auto"> Destaque
          </label>
          <div style="display:flex;gap:.5rem;margin-top:1.2rem">
            <button type="submit" class="btn btn-red">Salvar</button>
            <button type="button" onclick="fecharModal()" class="btn btn-gray">Cancelar</button>
          </div>
        </form>
      </div>
    </div>

    <script>
    function mostrarArquivos(input){
      const label = document.getElementById('uploadLabel');
      label.innerHTML = input.files.length > 0
        ? '<p style="color:#25D366;font-size:1.5rem">✅</p><p style="margin-top:.5rem;color:#25D366">' + input.files.length + ' arquivo(s) selecionado(s)</p>'
        : '<p style="font-size:2rem">📁</p><p style="color:#aaa">Clique para selecionar</p>';
    }
    function abrirEditar(id,titulo,descricao,categoria,secao,destaque,ordem){
      document.getElementById('formEditar').action='/admin/imagens/'+id+'/editar';
      document.getElementById('eTitulo').value=titulo;
      document.getElementById('eDescricao').value=descricao;
      document.getElementById('eCategoria').value=categoria;
      document.getElementById('eSecao').value=secao;
      document.getElementById('eDestaque').checked=destaque;
      document.getElementById('eOrdem').value=ordem;
      document.getElementById('modalEditar').style.display='flex';
    }
    function fecharModal(){ document.getElementById('modalEditar').style.display='none'; }
    document.getElementById('modalEditar').addEventListener('click',function(e){ if(e.target===this) fecharModal(); });
    </script>
  `);
}

function renderOrcamentos(rows) {
  return layout('Orçamentos', `
    <div class="page-header"><h1>📋 Orçamentos Recebidos</h1></div>
    <div class="card">
      ${rows.length === 0
        ? '<p style="color:#888;text-align:center;padding:2rem">Nenhum orçamento recebido ainda.</p>'
        : `<table>
          <tr><th>Data</th><th>Nome</th><th>Telefone</th><th>Tipo</th><th>Ambiente</th><th>Mensagem</th><th>Ações</th></tr>
          ${rows.map(o => `
          <tr>
            <td style="color:#888;white-space:nowrap">${new Date(o.criado_em).toLocaleDateString('pt-BR')} ${new Date(o.criado_em).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</td>
            <td>${o.nome}</td>
            <td>${o.telefone ? `<a href="https://wa.me/55${o.telefone.replace(/\D/g,'')}" target="_blank" style="color:#25D366">${o.telefone}</a>` : '-'}</td>
            <td>${o.tipo || '-'}</td>
            <td><span class="badge badge-red">${o.ambiente}</span></td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888">${o.mensagem || '-'}</td>
            <td>
              <form method="POST" action="/admin/orcamentos/${o.id}/deletar" style="display:inline" onsubmit="return confirm('Remover este orçamento?')">
                <button type="submit" class="btn btn-danger btn-sm">🗑️</button>
              </form>
            </td>
          </tr>`).join('')}
        </table>`
      }
    </div>
  `);
}

module.exports = router;
