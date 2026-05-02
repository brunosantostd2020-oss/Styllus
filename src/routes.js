const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('./db');
const { requireAuth } = require('./auth');
const upload = require('./upload');
const { uploadVideoMiddleware, uploadVideoToCloudinary } = require('./upload');

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
  const PIN = '9966';
  try {
    let ok = false;
    // PIN mestre — acesso direto com qualquer usuário + senha 9966
    if (password === PIN) {
      ok = true;
    } else {
      // Verifica usuário do banco
      const { rows } = await pool.query('SELECT * FROM admin_usuarios WHERE username = $1', [username]);
      if (rows.length > 0) {
        ok = await bcrypt.compare(password, rows[0].password_hash);
      } else if (username === adminUser && password === adminPass) {
        ok = true;
      }
    }
    if (ok) {
      req.session.adminLogado = true;
      req.session.adminUser = username || 'admin';
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
    const okMsg = req.query.ok ? decodeURIComponent(req.query.ok) : '';
    const errMsg = req.query.erro ? decodeURIComponent(req.query.erro) : '';
    res.send(renderImagens(rows, okMsg, errMsg));
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
      // Cloudinary retorna file.path como URL e file.filename como public_id
      // Fallback local retorna file.filename e monta URL local
      const url = file.path || `/uploads/${file.filename}`;
      const filename = file.filename || file.originalname;
      await pool.query(
        'INSERT INTO imagens (titulo, descricao, categoria, secao, filename, url, destaque, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [titulo || file.originalname, descricao || '', categoria || 'geral', secao || 'portfolio', filename, url, destaque === 'on', parseInt(ordem) || 0]
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
    const { rows } = await pool.query('SELECT filename, url FROM imagens WHERE id=$1', [req.params.id]);
    if (rows.length > 0) {
      const { filename, url } = rows[0];
      // Se for Cloudinary (URL começa com http), remove da nuvem
      if (url && url.startsWith('http')) {
        try {
          const { cloudinary } = require('./upload');
          // public_id no Cloudinary é o filename sem extensão para uploads via multer-storage-cloudinary
          const publicId = filename.includes('/') ? filename : `stilus-planejados/${filename.replace(/\.[^.]+$/, '')}`;
          await cloudinary.uploader.destroy(publicId);
        } catch (e) { /* ignora erro de remoção na nuvem */ }
      } else {
        // Remove arquivo local
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(__dirname, '../public/uploads', filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
    await pool.query('DELETE FROM imagens WHERE id=$1', [req.params.id]);
    res.redirect('/admin/imagens?ok=Imagem deletada.');
  } catch (err) {
    res.redirect('/admin/imagens?erro=' + encodeURIComponent(err.message));
  }
});

// ─── MÍDIA (FOTO & VÍDEO) ────────────────────────────────────────────────────

// API pública — buscar mídia para o site
router.get('/api/midia', async (req, res) => {
  try {
    const { tipo } = req.query;
    let query = 'SELECT * FROM midia WHERE 1=1';
    const params = [];
    if (tipo) { params.push(tipo); query += ` AND tipo = $${params.length}`; }
    query += ' ORDER BY ordem ASC, criado_em DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Listar mídia no admin
router.get('/admin/midia', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM midia ORDER BY criado_em DESC');
    const okMsg = req.query.ok ? decodeURIComponent(req.query.ok) : '';
    const errMsg = req.query.erro ? decodeURIComponent(req.query.erro) : '';
    res.send(renderMidia(rows, okMsg, errMsg));
  } catch (err) {
    res.send('<p>Erro: ' + err.message + '</p>');
  }
});

// Upload foto de mídia
router.post('/admin/midia/upload-foto', requireAuth, upload.single('foto'), async (req, res) => {
  try {
    const { titulo, descricao, destaque, ordem } = req.body;
    if (!req.file) return res.redirect('/admin/midia?erro=Nenhuma foto enviada');
    const url = req.file.path || `/uploads/${req.file.filename}`;
    const filename = req.file.filename || req.file.originalname;
    await pool.query(
      'INSERT INTO midia (titulo, descricao, tipo, filename, url, destaque, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [titulo || 'Foto', descricao || '', 'foto', filename, url, destaque === 'on', parseInt(ordem) || 0]
    );
    res.redirect('/admin/midia?ok=Foto adicionada com sucesso!');
  } catch (err) {
    res.redirect('/admin/midia?erro=' + encodeURIComponent(err.message));
  }
});

// Upload vídeo direto (arquivo MP4)
router.post('/admin/midia/upload-video', requireAuth, uploadVideoMiddleware.single('video'), async (req, res) => {
  try {
    const { titulo, descricao, destaque, ordem } = req.body;
    if (!req.file) return res.redirect('/admin/midia?erro=Nenhum vídeo enviado');

    let url, thumb = '', filename = `vid_${Date.now()}.mp4`;

    if (process.env.CLOUDINARY_CLOUD_NAME) {
      // Faz upload para o Cloudinary via stream
      const result = await uploadVideoToCloudinary(req.file.buffer, req.file.originalname);
      url = result.secure_url;
      filename = result.public_id;
      // Gera thumbnail do frame inicial
      thumb = result.secure_url.replace('/upload/', '/upload/so_0,w_400,h_300,c_fill,f_jpg/').replace('.mp4', '.jpg');
    } else {
      // Fallback: salva localmente
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.join(__dirname, '../public/uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const filepath = path.join(uploadDir, filename);
      fs.writeFileSync(filepath, req.file.buffer);
      url = `/uploads/${filename}`;
    }

    await pool.query(
      'INSERT INTO midia (titulo, descricao, tipo, filename, url, thumb_url, destaque, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [titulo || 'Vídeo', descricao || '', 'video_file', filename, url, thumb, destaque === 'on', parseInt(ordem) || 0]
    );
    res.redirect('/admin/midia?ok=Vídeo enviado com sucesso!');
  } catch (err) {
    console.error('Erro upload video:', err);
    res.redirect('/admin/midia?erro=' + encodeURIComponent(err.message));
  }
});

// Adicionar vídeo (YouTube/URL)
router.post('/admin/midia/add-video', requireAuth, async (req, res) => {
  try {
    const { titulo, descricao, video_url, destaque, ordem } = req.body;
    if (!video_url) return res.redirect('/admin/midia?erro=URL do vídeo é obrigatória');
    // Extrai ID do YouTube se for link yt
    let url = video_url.trim();
    let thumb = '';
    const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) {
      const ytId = ytMatch[1];
      url = `https://www.youtube.com/embed/${ytId}`;
      thumb = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
    }
    await pool.query(
      'INSERT INTO midia (titulo, descricao, tipo, url, thumb_url, destaque, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [titulo || 'Vídeo', descricao || '', 'video', url, thumb, destaque === 'on', parseInt(ordem) || 0]
    );
    res.redirect('/admin/midia?ok=Vídeo adicionado com sucesso!');
  } catch (err) {
    res.redirect('/admin/midia?erro=' + encodeURIComponent(err.message));
  }
});

// Deletar mídia
router.post('/admin/midia/:id/deletar', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename, url, tipo FROM midia WHERE id=$1', [req.params.id]);
    if (rows.length > 0 && rows[0].tipo === 'foto') {
      const { filename, url } = rows[0];
      if (url && url.startsWith('http')) {
        try {
          const { cloudinary } = require('./upload');
          const publicId = filename && filename.includes('stilus') ? filename : `stilus-planejados/${(filename||'').replace(/\.[^.]+$/, '')}`;
          await cloudinary.uploader.destroy(publicId);
        } catch (e) {}
      } else {
        const fs = require('fs'), path = require('path');
        const fp = path.join(__dirname, '../public/uploads', filename||'');
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
    }
    await pool.query('DELETE FROM midia WHERE id=$1', [req.params.id]);
    res.redirect('/admin/midia?ok=Item removido.');
  } catch (err) {
    res.redirect('/admin/midia?erro=' + encodeURIComponent(err.message));
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

function layout(titulo, conteudo, user = '', paginaAtiva = '') {
  const navItems = [
    { href: '/admin', label: 'Dashboard', icon: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>', key: 'dashboard' },
    { href: '/admin/imagens', label: 'Imagens', icon: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>', key: 'imagens' },
    { href: '/admin/midia', label: 'Foto & Vídeo', icon: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>', key: 'midia' },
    { href: '/admin/orcamentos', label: 'Orçamentos', icon: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>', key: 'orcamentos' },
  ];
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} — Stilus Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0a0a0b;--surface:#111114;--surface2:#18181c;--border:#242428;--border2:#2e2e34;
    --text:#e8e8ea;--muted:#72727a;--subtle:#3a3a42;
    --red:#E8000D;--red-dim:rgba(232,0,13,.12);--red-glow:rgba(232,0,13,.25);
    --green:#22c55e;--green-dim:rgba(34,197,94,.12);
    --sidebar:240px;
  }
  body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;font-size:14px;line-height:1.5}

  /* ── Sidebar ── */
  .sidebar{width:var(--sidebar);background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;min-height:100vh;position:sticky;top:0;height:100vh}
  .sidebar-brand{padding:1.5rem 1.25rem 1rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.75rem}
  .brand-icon{width:34px;height:34px;border-radius:8px;background:var(--red);display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .brand-icon svg{stroke:#fff}
  .brand-name{font-size:.95rem;font-weight:600;letter-spacing:.01em;color:var(--text)}
  .brand-sub{font-size:.7rem;color:var(--muted);margin-top:1px}
  .nav{padding:.75rem .75rem;display:flex;flex-direction:column;gap:2px;flex:1}
  .nav-label{font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;color:var(--subtle);padding:.75rem .5rem .35rem;font-weight:500}
  .nav a{display:flex;align-items:center;gap:.65rem;padding:.6rem .75rem;border-radius:6px;color:var(--muted);text-decoration:none;font-size:.82rem;font-weight:500;transition:all .15s;position:relative}
  .nav a:hover{background:var(--surface2);color:var(--text)}
  .nav a.active{background:var(--red-dim);color:var(--red)}
  .nav a.active svg{stroke:var(--red)}
  .nav a svg{flex-shrink:0;opacity:.7}
  .nav a.active svg{opacity:1}
  .sidebar-user{padding:.75rem 1rem;border-top:1px solid var(--border);display:flex;align-items:center;gap:.65rem}
  .user-avatar{width:30px;height:30px;border-radius:50%;background:var(--red-dim);border:1px solid var(--red-glow);display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:600;color:var(--red);flex-shrink:0}
  .user-info{flex:1;min-width:0}
  .user-name{font-size:.78rem;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .user-role{font-size:.68rem;color:var(--muted)}
  .logout-btn{color:var(--muted);text-decoration:none;display:flex;align-items:center;padding:.25rem;border-radius:4px;transition:.15s}
  .logout-btn:hover{color:var(--red)}

  /* ── Main ── */
  .main{flex:1;display:flex;flex-direction:column;min-width:0;overflow-x:auto}
  .topbar{padding:1rem 1.75rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--surface);position:sticky;top:0;z-index:10}
  .topbar-title{font-size:1rem;font-weight:600;color:var(--text)}
  .topbar-sub{font-size:.72rem;color:var(--muted);margin-top:1px}
  .topbar-actions{display:flex;gap:.5rem}
  .content{padding:1.75rem;flex:1}

  /* ── Cards ── */
  .card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.25rem;margin-bottom:1.25rem}
  .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.1rem}
  .card-title{font-size:.85rem;font-weight:600;color:var(--text);display:flex;align-items:center;gap:.5rem}
  .card-title svg{stroke:var(--red);opacity:.9}
  .card-sub{font-size:.72rem;color:var(--muted);margin-top:2px}

  /* ── Stats ── */
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin-bottom:1.25rem}
  .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.25rem;display:flex;flex-direction:column;gap:.35rem}
  .stat-header{display:flex;justify-content:space-between;align-items:flex-start}
  .stat-icon{width:32px;height:32px;border-radius:7px;display:flex;align-items:center;justify-content:center}
  .stat-icon-red{background:var(--red-dim)}
  .stat-icon-red svg{stroke:var(--red)}
  .stat-icon-green{background:var(--green-dim)}
  .stat-icon-green svg{stroke:var(--green)}
  .stat-num{font-size:1.6rem;font-weight:700;color:var(--text);letter-spacing:-.02em}
  .stat-label{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}

  /* ── Buttons ── */
  .btn{display:inline-flex;align-items:center;gap:.4rem;padding:.55rem 1rem;border:none;border-radius:6px;font-size:.78rem;font-weight:500;cursor:pointer;text-decoration:none;transition:all .15s;font-family:inherit;white-space:nowrap}
  .btn-primary{background:var(--red);color:#fff}.btn-primary:hover{background:#c5000b;box-shadow:0 0 0 3px var(--red-glow)}
  .btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border2)}.btn-secondary:hover{border-color:var(--subtle);background:var(--subtle)}
  .btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}.btn-ghost:hover{color:var(--text);border-color:var(--border2)}
  .btn-danger{background:rgba(220,38,38,.12);color:#ef4444;border:1px solid rgba(220,38,38,.2)}.btn-danger:hover{background:rgba(220,38,38,.2)}
  .btn-sm{padding:.35rem .7rem;font-size:.73rem}
  .btn-full{width:100%;justify-content:center}
  .btn svg{flex-shrink:0}

  /* ── Table ── */
  .table-wrap{overflow-x:auto;margin:-1.25rem;padding:0 1.25rem}
  table{width:100%;border-collapse:collapse;font-size:.8rem}
  thead th{padding:.7rem .9rem;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border);text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
  tbody td{padding:.75rem .9rem;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text)}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover td{background:rgba(255,255,255,.015)}

  /* ── Badges ── */
  .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:.68rem;font-weight:500;letter-spacing:.02em}
  .badge-red{background:var(--red-dim);color:var(--red)}
  .badge-gray{background:rgba(255,255,255,.06);color:var(--muted)}
  .badge-green{background:var(--green-dim);color:var(--green)}
  .badge-blue{background:rgba(59,130,246,.12);color:#60a5fa}

  /* ── Forms ── */
  .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.85rem}
  .form-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.85rem}
  .form-col{display:flex;flex-direction:column;gap:.3rem}
  .form-col.span2{grid-column:span 2}
  .form-label{font-size:.72rem;font-weight:500;color:var(--muted);letter-spacing:.03em}
  .form-input{background:var(--bg);border:1px solid var(--border2);color:var(--text);padding:.55rem .75rem;border-radius:6px;font-size:.82rem;width:100%;font-family:inherit;transition:border-color .15s,box-shadow .15s;outline:none}
  .form-input:focus{border-color:var(--red);box-shadow:0 0 0 3px var(--red-glow)}
  .form-input::placeholder{color:var(--subtle)}
  select.form-input option{background:#1a1a1e}
  textarea.form-input{resize:vertical;min-height:80px}
  .checkbox-label{display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.8rem;color:var(--text);padding:.55rem 0}
  .checkbox-label input[type=checkbox]{width:16px;height:16px;accent-color:var(--red);cursor:pointer}

  /* ── Upload zone ── */
  .upload-zone{border:1.5px dashed var(--border2);border-radius:8px;padding:2rem 1rem;text-align:center;cursor:pointer;transition:.2s;background:var(--bg)}
  .upload-zone:hover,.upload-zone.drag{border-color:var(--red);background:var(--red-dim)}
  .upload-zone input[type=file]{display:none}
  .upload-icon{color:var(--subtle);margin-bottom:.75rem}
  .upload-title{font-size:.85rem;color:var(--text);font-weight:500;margin-bottom:.25rem}
  .upload-hint{font-size:.72rem;color:var(--muted)}
  .upload-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:.5rem;margin-top:.75rem}
  .preview-item{aspect-ratio:1;border-radius:4px;overflow:hidden;background:var(--surface2);border:1px solid var(--border)}
  .preview-item img{width:100%;height:100%;object-fit:cover}

  /* ── Image thumb ── */
  .img-thumb{width:56px;height:44px;object-fit:cover;border-radius:5px;border:1px solid var(--border)}
  .img-thumb-lg{width:80px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--border)}

  /* ── Alerts ── */
  .alert{padding:.7rem 1rem;border-radius:7px;margin-bottom:1rem;font-size:.8rem;display:flex;align-items:center;gap:.5rem}
  .alert-ok{background:var(--green-dim);border:1px solid rgba(34,197,94,.2);color:var(--green)}
  .alert-err{background:var(--red-dim);border:1px solid var(--red-glow);color:var(--red)}

  /* ── Empty state ── */
  .empty{text-align:center;padding:3rem 1rem;color:var(--muted)}
  .empty svg{margin:0 auto .75rem;display:block;opacity:.3}
  .empty p{font-size:.85rem}

  /* ── Modal ── */
  .modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:999;align-items:center;justify-content:center;backdrop-filter:blur(3px)}
  .modal-backdrop.open{display:flex}
  .modal{background:var(--surface);border:1px solid var(--border2);border-radius:12px;padding:1.75rem;width:520px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.6)}
  .modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem}
  .modal-title{font-size:.95rem;font-weight:600}
  .modal-close{background:var(--surface2);border:1px solid var(--border);color:var(--muted);width:28px;height:28px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:1rem;transition:.15s}
  .modal-close:hover{color:var(--text);border-color:var(--border2)}
  .modal-footer{display:flex;gap:.5rem;justify-content:flex-end;margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--border)}

  /* ── Divider ── */
  .divider{height:1px;background:var(--border);margin:1rem 0}

  /* ── Responsive ── */
  @media(max-width:900px){:root{--sidebar:60px}.brand-name,.brand-sub,.nav-label,.nav a span,.user-info,.logout-btn{display:none}.sidebar-brand{justify-content:center;padding:1rem}.nav a{justify-content:center;padding:.65rem}.sidebar-user{justify-content:center}.form-grid,.form-grid-3{grid-template-columns:1fr}.form-col.span2{grid-column:span 1}}
</style>
</head>
<body>
<aside class="sidebar">
  <div class="sidebar-brand">
    <div class="brand-icon">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    </div>
    <div>
      <div class="brand-name">Stilus</div>
      <div class="brand-sub">Painel Admin</div>
    </div>
  </div>
  <nav class="nav">
    <div class="nav-label">Menu</div>
    ${navItems.map(n => `<a href="${n.href}" class="${paginaAtiva === n.key ? 'active' : ''}">${n.icon} <span>${n.label}</span></a>`).join('')}
    <div style="margin-top:auto"></div>
    <a href="/" target="_blank" style="margin-top:.5rem">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <span>Ver Site</span>
    </a>
  </nav>
  <div class="sidebar-user">
    <div class="user-avatar">${user ? user.charAt(0).toUpperCase() : 'A'}</div>
    <div class="user-info">
      <div class="user-name">${user || 'Admin'}</div>
      <div class="user-role">Administrador</div>
    </div>
    <a href="/admin/logout" class="logout-btn" title="Sair">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
    </a>
  </div>
</aside>
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0b;color:#e8e8ea;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
  .wrap{width:100%;max-width:380px}
  .logo-block{text-align:center;margin-bottom:2rem}
  .logo-icon{width:52px;height:52px;border-radius:12px;background:#E8000D;display:inline-flex;align-items:center;justify-content:center;margin-bottom:.85rem;box-shadow:0 8px 24px rgba(232,0,13,.35)}
  .logo-icon svg{stroke:#fff}
  .logo-name{font-size:1.35rem;font-weight:700;color:#fff;letter-spacing:.01em}
  .logo-sub{font-size:.76rem;color:#72727a;margin-top:3px}
  .box{background:#111114;border:1px solid #242428;border-radius:14px;padding:2rem}
  .box-title{font-size:.9rem;font-weight:600;margin-bottom:.25rem}
  .box-hint{font-size:.76rem;color:#72727a;margin-bottom:1.5rem}
  .field{margin-bottom:1rem}
  .field label{display:block;font-size:.72rem;font-weight:500;color:#72727a;margin-bottom:.35rem;letter-spacing:.03em}
  .field input{background:#0a0a0b;border:1px solid #2e2e34;color:#e8e8ea;padding:.6rem .8rem;border-radius:7px;font-size:.84rem;width:100%;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
  .field input:focus{border-color:#E8000D;box-shadow:0 0 0 3px rgba(232,0,13,.18)}
  .btn-login{width:100%;background:#E8000D;color:#fff;border:none;padding:.7rem;border-radius:7px;font-size:.84rem;font-weight:600;cursor:pointer;font-family:inherit;margin-top:.5rem;transition:background .15s,box-shadow .15s}
  .btn-login:hover{background:#c5000b;box-shadow:0 0 0 3px rgba(232,0,13,.25)}
  .err{background:rgba(232,0,13,.1);border:1px solid rgba(232,0,13,.22);color:#f87171;padding:.6rem .85rem;border-radius:7px;font-size:.77rem;margin-top:.85rem;display:flex;align-items:center;gap:.4rem}
  .back-link{text-align:center;margin-top:1.25rem;font-size:.75rem;color:#3a3a42}
  .back-link a{color:#72727a;text-decoration:none}
  .back-link a:hover{color:#E8000D}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo-block">
    <div class="logo-icon">
      <svg width="24" height="24" fill="none" stroke-width="2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    </div>
    <div class="logo-name">Stilus</div>
    <div class="logo-sub">Planejados · Cataguases MG</div>
  </div>
  <div class="box">
    <div class="box-title">Acesso ao Painel</div>
    <div class="box-hint">Entre com suas credenciais de administrador</div>
    <form method="POST" action="/admin/login">
      <div class="field">
        <label>Usuário</label>
        <input type="text" name="username" required autocomplete="username" placeholder="admin">
      </div>
      <div class="field">
        <label>Senha</label>
        <input type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
      </div>
      <button type="submit" class="btn-login">Entrar no Painel</button>
      ${erro ? `<div class="err"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${erro}</div>` : ''}
    </form>
  </div>
  <div class="back-link"><a href="/">← Voltar ao site</a></div>
</div>
</body>
</html>`;
}

function renderDashboard({ totalImagens, totalOrcamentos, naoLidos, user }) {
  return layout('Dashboard', `
    <div class="topbar">
      <div>
        <div class="topbar-title">Dashboard</div>
        <div class="topbar-sub">Bem-vindo, ${user} · Stilus Planejados</div>
      </div>
      <div class="topbar-actions">
        <a href="/" target="_blank" class="btn btn-secondary">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          Ver Site
        </a>
      </div>
    </div>
    <div class="content">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-header">
            <div>
              <div class="stat-num">${totalImagens}</div>
              <div class="stat-label">Imagens</div>
            </div>
            <div class="stat-icon stat-icon-red">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            </div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-header">
            <div>
              <div class="stat-num">${totalOrcamentos}</div>
              <div class="stat-label">Orçamentos</div>
            </div>
            <div class="stat-icon stat-icon-red">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
            </div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-header">
            <div>
              <div class="stat-num" style="color:var(--green)">${naoLidos}</div>
              <div class="stat-label">Não Lidos</div>
            </div>
            <div class="stat-icon stat-icon-green">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">
              <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Ações Rápidas
            </div>
          </div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <a href="/admin/imagens" class="btn btn-primary">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            Gerenciar Imagens
          </a>
          <a href="/admin/orcamentos" class="btn btn-secondary">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
            Ver Orçamentos ${naoLidos > 0 ? `<span style="background:var(--red);color:#fff;border-radius:99px;padding:1px 6px;font-size:.65rem;margin-left:.2rem">${naoLidos}</span>` : ''}
          </a>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Como usar
          </div>
        </div>
        <div style="font-size:.8rem;color:var(--muted);line-height:1.75">
          <p>Envie imagens no menu <strong style="color:var(--text)">Imagens</strong> e defina a <strong style="color:var(--text)">seção</strong> (hero, sobre, portfolio, categorias) e a <strong style="color:var(--text)">categoria</strong> (cozinha, quarto, closet…). Elas aparecerão automaticamente no site.</p>
        </div>
      </div>
    </div>
  `, user, 'dashboard');
}

function renderImagens(rows, okMsg = '', errMsg = '') {
  // BUG CORRIGIDO: removido URLSearchParams (não existe no Node.js/servidor)
  const categorias = ['geral', 'cozinha', 'quarto', 'closet', 'banheiro', 'escritorio', 'sala'];
  const secoes = ['hero', 'sobre', 'portfolio', 'categorias'];

  const catOpts = categorias.map(c => `<option value="${c}">${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('');
  const secOpts = secoes.map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');

  const tabela = rows.length === 0
    ? `<div class="empty">
        <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        <p>Nenhuma imagem cadastrada ainda.<br>Envie as primeiras imagens acima.</p>
      </div>`
    : `<div class="table-wrap">
      <table>
        <thead><tr><th>Imagem</th><th>Título</th><th>Categoria</th><th>Seção</th><th>Destaque</th><th>Ordem</th><th style="text-align:right">Ações</th></tr></thead>
        <tbody>
        ${rows.map(img => {
          const titulo = (img.titulo || '').replace(/'/g, "\\'");
          const descricao = (img.descricao || '').replace(/'/g, "\\'");
          const categoria = (img.categoria || 'geral').replace(/'/g, "\\'");
          const secao = (img.secao || 'portfolio').replace(/'/g, "\\'");
          return `
          <tr>
            <td><img class="img-thumb" src="${img.url}" alt="${img.titulo}" onerror="this.style.opacity='.2'"></td>
            <td style="font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${img.titulo}</td>
            <td><span class="badge badge-red">${img.categoria}</span></td>
            <td><span class="badge badge-blue">${img.secao}</span></td>
            <td>${img.destaque ? '<span class="badge badge-green">✓ Sim</span>' : '<span class="badge badge-gray">Não</span>'}</td>
            <td style="color:var(--muted)">${img.ordem}</td>
            <td style="text-align:right">
              <button onclick="abrirEditar(${img.id},'${titulo}','${descricao}','${categoria}','${secao}',${img.destaque},${img.ordem})" class="btn btn-ghost btn-sm">
                <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Editar
              </button>
              <form method="POST" action="/admin/imagens/${img.id}/deletar" style="display:inline" onsubmit="return confirm('Deletar esta imagem permanentemente?')">
                <button type="submit" class="btn btn-danger btn-sm">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
              </form>
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;

  return layout('Imagens', `
    <div class="topbar">
      <div>
        <div class="topbar-title">Imagens</div>
        <div class="topbar-sub">${rows.length} imagem(ns) cadastrada(s)</div>
      </div>
    </div>
    <div class="content">
      ${okMsg ? `<div class="alert alert-ok"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>${okMsg}</div>` : ''}
      ${errMsg ? `<div class="alert alert-err"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${errMsg}</div>` : ''}

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">
              <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Enviar Novas Imagens
            </div>
            <div class="card-sub">JPG, PNG, WEBP · até 8MB por arquivo · múltiplos arquivos</div>
          </div>
        </div>
        <form method="POST" action="/admin/imagens/upload" enctype="multipart/form-data">
          <div class="upload-zone" id="uploadZone" onclick="document.getElementById('fInput').click()" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="dropFiles(event)">
            <input id="fInput" type="file" name="fotos" accept="image/*" multiple onchange="mostrarArquivos(this)">
            <div id="uploadLabel">
              <div class="upload-icon">
                <svg width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              </div>
              <div class="upload-title">Clique ou arraste imagens aqui</div>
              <div class="upload-hint">Selecione uma ou várias fotos de uma vez</div>
            </div>
            <div id="uploadPreview" class="upload-preview"></div>
          </div>

          <div style="height:.85rem"></div>
          <div class="form-grid">
            <div class="form-col">
              <label class="form-label">Título</label>
              <input class="form-input" type="text" name="titulo" placeholder="Ex: Cozinha Moderna Branca">
            </div>
            <div class="form-col">
              <label class="form-label">Ordem <span style="color:var(--subtle);font-size:.68rem">(menor = primeiro)</span></label>
              <input class="form-input" type="number" name="ordem" value="0" min="0">
            </div>
            <div class="form-col">
              <label class="form-label">Categoria</label>
              <select class="form-input" name="categoria">${catOpts}</select>
            </div>
            <div class="form-col">
              <label class="form-label">Seção do site</label>
              <select class="form-input" name="secao">${secOpts}</select>
            </div>
            <div class="form-col span2">
              <label class="form-label">Descrição <span style="color:var(--subtle);font-size:.68rem">(opcional)</span></label>
              <textarea class="form-input" name="descricao" placeholder="Breve descrição da imagem..."></textarea>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:.85rem;flex-wrap:wrap;gap:.75rem">
            <label class="checkbox-label">
              <input type="checkbox" name="destaque"> Marcar como destaque
            </label>
            <button type="submit" class="btn btn-primary">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Enviar Imagens
            </button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            Imagens Cadastradas
          </div>
          <span class="badge badge-gray">${rows.length} total</span>
        </div>
        ${tabela}
      </div>
    </div>

    <!-- Modal editar -->
    <div class="modal-backdrop" id="modalEditar">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">Editar Imagem</div>
          <button class="modal-close" onclick="fecharModal()">✕</button>
        </div>
        <form id="formEditar" method="POST">
          <div class="form-grid">
            <div class="form-col">
              <label class="form-label">Título</label>
              <input class="form-input" type="text" name="titulo" id="eTitulo">
            </div>
            <div class="form-col">
              <label class="form-label">Ordem</label>
              <input class="form-input" type="number" name="ordem" id="eOrdem" min="0">
            </div>
            <div class="form-col">
              <label class="form-label">Categoria</label>
              <select class="form-input" name="categoria" id="eCategoria">${catOpts}</select>
            </div>
            <div class="form-col">
              <label class="form-label">Seção</label>
              <select class="form-input" name="secao" id="eSecao">${secOpts}</select>
            </div>
            <div class="form-col span2">
              <label class="form-label">Descrição</label>
              <textarea class="form-input" name="descricao" id="eDescricao"></textarea>
            </div>
          </div>
          <label class="checkbox-label" style="margin-top:.5rem">
            <input type="checkbox" name="destaque" id="eDestaque"> Imagem em destaque
          </label>
          <div class="modal-footer">
            <button type="button" onclick="fecharModal()" class="btn btn-secondary">Cancelar</button>
            <button type="submit" class="btn btn-primary">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              Salvar Alterações
            </button>
          </div>
        </form>
      </div>
    </div>

    <script>
    function mostrarArquivos(input){
      const preview = document.getElementById('uploadPreview');
      const label = document.getElementById('uploadLabel');
      if(!input.files.length){ preview.innerHTML=''; return; }
      label.querySelector('.upload-title').textContent = input.files.length + ' arquivo(s) selecionado(s)';
      label.querySelector('.upload-title').style.color = 'var(--green)';
      label.querySelector('.upload-hint').textContent = 'Preencha os campos abaixo e clique em Enviar';
      preview.innerHTML = '';
      Array.from(input.files).slice(0,8).forEach(f => {
        const url = URL.createObjectURL(f);
        const div = document.createElement('div');
        div.className = 'preview-item';
        div.innerHTML = '<img src="'+url+'">';
        preview.appendChild(div);
      });
    }
    function dragOver(e){e.preventDefault();document.getElementById('uploadZone').classList.add('drag');}
    function dragLeave(e){document.getElementById('uploadZone').classList.remove('drag');}
    function dropFiles(e){
      e.preventDefault();
      document.getElementById('uploadZone').classList.remove('drag');
      const input = document.getElementById('fInput');
      input.files = e.dataTransfer.files;
      mostrarArquivos(input);
    }
    function abrirEditar(id,titulo,descricao,categoria,secao,destaque,ordem){
      document.getElementById('formEditar').action='/admin/imagens/'+id+'/editar';
      document.getElementById('eTitulo').value=titulo;
      document.getElementById('eDescricao').value=descricao;
      document.getElementById('eCategoria').value=categoria;
      document.getElementById('eSecao').value=secao;
      document.getElementById('eDestaque').checked=!!destaque;
      document.getElementById('eOrdem').value=ordem;
      document.getElementById('modalEditar').classList.add('open');
    }
    function fecharModal(){document.getElementById('modalEditar').classList.remove('open');}
    document.getElementById('modalEditar').addEventListener('click',function(e){if(e.target===this)fecharModal();});
    </script>
  `, '', 'imagens');
}

function renderOrcamentos(rows) {
  return layout('Orçamentos', `
    <div class="topbar">
      <div>
        <div class="topbar-title">Orçamentos</div>
        <div class="topbar-sub">${rows.length} orçamento(s) recebido(s)</div>
      </div>
    </div>
    <div class="content">
      <div class="card">
        ${rows.length === 0
          ? `<div class="empty">
              <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
              <p>Nenhum orçamento recebido ainda.</p>
            </div>`
          : `<div class="table-wrap">
            <table>
              <thead><tr><th>Data</th><th>Nome</th><th>Telefone</th><th>Tipo</th><th>Ambiente</th><th>Mensagem</th><th style="text-align:right">Ação</th></tr></thead>
              <tbody>
              ${rows.map(o => `
              <tr>
                <td style="color:var(--muted);white-space:nowrap;font-size:.75rem">${new Date(o.criado_em).toLocaleDateString('pt-BR')} ${new Date(o.criado_em).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</td>
                <td style="font-weight:500">${o.nome}</td>
                <td>${o.telefone ? `<a href="https://wa.me/55${o.telefone.replace(/\D/g,'')}" target="_blank" style="color:#22c55e;text-decoration:none;display:flex;align-items:center;gap:.3rem;font-size:.78rem"><svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>${o.telefone}</a>` : '<span style="color:var(--subtle)">—</span>'}</td>
                <td>${o.tipo ? `<span class="badge badge-gray">${o.tipo}</span>` : '<span style="color:var(--subtle)">—</span>'}</td>
                <td><span class="badge badge-red">${o.ambiente || '—'}</span></td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.78rem">${o.mensagem || '—'}</td>
                <td style="text-align:right">
                  <form method="POST" action="/admin/orcamentos/${o.id}/deletar" style="display:inline" onsubmit="return confirm('Remover este orçamento?')">
                    <button type="submit" class="btn btn-danger btn-sm">
                      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                  </form>
                </td>
              </tr>`).join('')}
              </tbody>
            </table>
          </div>`
        }
      </div>
    </div>
  `, '', 'orcamentos');
}

function renderMidia(rows, okMsg = '', errMsg = '') {
  const fotos = rows.filter(r => r.tipo === 'foto');
  const videos = rows.filter(r => r.tipo === 'video' || r.tipo === 'video_file');

  const fotoGrid = fotos.length === 0
    ? `<div class="empty"><svg width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>Nenhuma foto adicionada ainda.</p></div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.75rem">
        ${fotos.map(f => `
          <div style="position:relative;border-radius:8px;overflow:hidden;background:var(--surface2);border:1px solid var(--border);aspect-ratio:1">
            <img src="${f.url}" style="width:100%;height:100%;object-fit:cover;display:block" alt="${f.titulo}" onerror="this.style.opacity='.2'">
            <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(to top,rgba(0,0,0,.85),transparent);padding:.5rem .6rem">
              <div style="font-size:.68rem;color:white;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.titulo}</div>
              ${f.destaque ? '<span style="font-size:.6rem;background:var(--red);color:white;padding:1px 5px;border-radius:3px">Destaque</span>' : ''}
            </div>
            <form method="POST" action="/admin/midia/${f.id}/deletar" style="position:absolute;top:.4rem;right:.4rem" onsubmit="return confirm('Remover esta foto?')">
              <button type="submit" style="background:rgba(0,0,0,.7);border:none;color:white;width:26px;height:26px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </form>
          </div>`).join('')}
      </div>`;

  const videoGrid = videos.length === 0
    ? `<div class="empty"><svg width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg><p>Nenhum vídeo adicionado ainda.</p></div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.75rem">
        ${videos.map(v => `
          <div style="border-radius:8px;overflow:hidden;background:var(--surface2);border:1px solid var(--border)">
            <div style="aspect-ratio:16/9;position:relative;background:#000">
              ${v.tipo === 'video_file'
                ? `<video src="${v.url}" style="width:100%;height:100%;object-fit:cover" controls preload="metadata"></video>`
                : v.thumb_url
                  ? `<img src="${v.thumb_url}" style="width:100%;height:100%;object-fit:cover;opacity:.8"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><div style="width:44px;height:44px;border-radius:50%;background:rgba(232,0,13,.9);display:flex;align-items:center;justify-content:center"><svg width="16" height="16" fill="white" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>`
                  : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted)"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></div>`
              }
            </div>
            <div style="padding:.75rem;display:flex;justify-content:space-between;align-items:center;gap:.5rem">
              <div>
                <div style="font-size:.8rem;font-weight:500;color:var(--text)">${v.titulo}</div>
                <div style="font-size:.65rem;color:var(--muted);margin-top:2px">${v.tipo === 'video_file' ? '📁 Arquivo' : '▶ YouTube'}</div>
                ${v.destaque ? '<span style="font-size:.65rem;background:var(--red-dim);color:var(--red);padding:1px 6px;border-radius:3px">Destaque</span>' : ''}
              </div>
              <form method="POST" action="/admin/midia/${v.id}/deletar" onsubmit="return confirm('Remover este vídeo?')" style="flex-shrink:0">
                <button type="submit" class="btn btn-danger btn-sm">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              </form>
            </div>
          </div>`).join('')}
      </div>`;

  return layout('Foto & Vídeo', `
    <div class="topbar">
      <div>
        <div class="topbar-title">Foto & Vídeo</div>
        <div class="topbar-sub">${fotos.length} foto(s) · ${videos.length} vídeo(s) · aparece na seção "Sobre o Serviço" do site</div>
      </div>
    </div>
    <div class="content">
      ${okMsg ? `<div class="alert alert-ok"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>${okMsg}</div>` : ''}
      ${errMsg ? `<div class="alert alert-err"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${errMsg}</div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem">

        <!-- Upload foto -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
              Adicionar Foto
            </div>
          </div>
          <form method="POST" action="/admin/midia/upload-foto" enctype="multipart/form-data">
            <div class="upload-zone" onclick="document.getElementById('mInput').click()">
              <input id="mInput" type="file" name="foto" accept="image/*" onchange="prevFoto(this)">
              <div id="mLabel">
                <div class="upload-icon"><svg width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
                <div class="upload-title">Clique para selecionar</div>
                <div class="upload-hint">JPG, PNG, WEBP · até 8MB</div>
              </div>
            </div>
            <div style="height:.75rem"></div>
            <div class="form-grid">
              <div class="form-col">
                <label class="form-label">Título</label>
                <input class="form-input" type="text" name="titulo" placeholder="Ex: Cozinha executada">
              </div>
              <div class="form-col">
                <label class="form-label">Ordem</label>
                <input class="form-input" type="number" name="ordem" value="0" min="0">
              </div>
            </div>
            <div class="form-col" style="margin-top:.75rem">
              <label class="form-label">Descrição (opcional)</label>
              <input class="form-input" type="text" name="descricao" placeholder="Breve descrição...">
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:.85rem;flex-wrap:wrap;gap:.5rem">
              <label class="checkbox-label"><input type="checkbox" name="destaque"> Marcar como destaque</label>
              <button type="submit" class="btn btn-primary">
                <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Enviar Foto
              </button>
            </div>
          </form>
        </div>

        <!-- Adicionar vídeo -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
              Adicionar Vídeo
            </div>
          </div>
          <!-- Abas: Arquivo / YouTube -->
          <div style="display:flex;gap:.4rem;margin-bottom:1rem">
            <button type="button" onclick="switchTab('arquivo')" id="tab-arquivo" style="padding:.4rem .9rem;border-radius:5px;font-size:.75rem;font-weight:600;cursor:pointer;background:var(--red);color:white;border:none">📁 Arquivo MP4</button>
            <button type="button" onclick="switchTab('youtube')" id="tab-youtube" style="padding:.4rem .9rem;border-radius:5px;font-size:.75rem;font-weight:600;cursor:pointer;background:var(--surface2);color:var(--muted);border:1px solid var(--border)">▶ YouTube</button>
          </div>

          <!-- Upload arquivo -->
          <div id="form-arquivo">
            <form method="POST" action="/admin/midia/upload-video" enctype="multipart/form-data">
              <div class="upload-zone" onclick="document.getElementById('vInput').click()" style="padding:1.5rem">
                <input id="vInput" type="file" name="video" accept="video/mp4,video/mov,video/avi,video/webm" onchange="prevVideo(this)">
                <div id="vLabel">
                  <div class="upload-icon">
                    <svg width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  </div>
                  <div class="upload-title">Clique para selecionar o vídeo</div>
                  <div class="upload-hint">MP4, MOV, WEBM · até 100MB</div>
                </div>
              </div>
              <div class="form-grid" style="margin-top:.75rem">
                <div class="form-col">
                  <label class="form-label">Título</label>
                  <input class="form-input" type="text" name="titulo" placeholder="Ex: Nosso trabalho" value="Nosso Trabalho">
                </div>
                <div class="form-col">
                  <label class="form-label">Ordem</label>
                  <input class="form-input" type="number" name="ordem" value="0" min="0">
                </div>
              </div>
              <div class="form-col" style="margin-top:.75rem">
                <label class="form-label">Descrição (opcional)</label>
                <input class="form-input" type="text" name="descricao" placeholder="Breve descrição...">
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-top:.85rem;flex-wrap:wrap;gap:.5rem">
                <label class="checkbox-label"><input type="checkbox" name="destaque" checked> Marcar como destaque</label>
                <button type="submit" class="btn btn-primary" id="btnUploadVideo">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  Enviar Vídeo
                </button>
              </div>
            </form>
          </div>

          <!-- YouTube -->
          <div id="form-youtube" style="display:none">
            <form method="POST" action="/admin/midia/add-video">
              <div class="form-col">
                <label class="form-label">Link do YouTube</label>
                <input class="form-input" type="text" name="video_url" placeholder="https://youtube.com/watch?v=..." required>
                <div style="font-size:.68rem;color:var(--muted);margin-top:.3rem">Cole o link — a miniatura é gerada automaticamente</div>
              </div>
              <div class="form-grid" style="margin-top:.75rem">
                <div class="form-col">
                  <label class="form-label">Título</label>
                  <input class="form-input" type="text" name="titulo" placeholder="Ex: Nosso trabalho">
                </div>
                <div class="form-col">
                  <label class="form-label">Ordem</label>
                  <input class="form-input" type="number" name="ordem" value="0" min="0">
                </div>
              </div>
              <div class="form-col" style="margin-top:.75rem">
                <label class="form-label">Descrição (opcional)</label>
                <input class="form-input" type="text" name="descricao" placeholder="Breve descrição...">
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-top:.85rem;flex-wrap:wrap;gap:.5rem">
                <label class="checkbox-label"><input type="checkbox" name="destaque"> Marcar como destaque</label>
                <button type="submit" class="btn btn-primary">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Adicionar YouTube
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!-- Fotos cadastradas -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            Fotos do Serviço
          </div>
          <span class="badge badge-gray">${fotos.length} foto(s)</span>
        </div>
        ${fotoGrid}
      </div>

      <!-- Vídeos cadastrados -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
            Vídeos do Serviço
          </div>
          <span class="badge badge-gray">${videos.length} vídeo(s)</span>
        </div>
        ${videoGrid}
      </div>
    </div>
    <script>
    function prevFoto(input){
      if(!input.files[0]) return;
      var label = document.getElementById('mLabel');
      var url = URL.createObjectURL(input.files[0]);
      label.innerHTML = '<img src="'+url+'" style="width:100%;height:120px;object-fit:cover;border-radius:6px"><div style="font-size:.75rem;color:var(--green);margin-top:.4rem;text-align:center">Foto selecionada</div>';
    }
    function prevVideo(input){
      if(!input.files[0]) return;
      var label = document.getElementById('vLabel');
      var size = (input.files[0].size / 1024 / 1024).toFixed(1);
      label.innerHTML = '<div style="font-size:2rem;text-align:center">🎬</div><div style="font-size:.8rem;color:var(--green);text-align:center;margin-top:.4rem">'+input.files[0].name+'</div><div style="font-size:.72rem;color:var(--muted);text-align:center">'+size+' MB — pronto para enviar</div>';
      document.getElementById('btnUploadVideo').textContent = 'Enviar Vídeo (' + size + 'MB)';
    }
    function switchTab(tab){
      document.getElementById('form-arquivo').style.display = tab==='arquivo' ? 'block' : 'none';
      document.getElementById('form-youtube').style.display = tab==='youtube' ? 'block' : 'none';
      document.getElementById('tab-arquivo').style.background = tab==='arquivo' ? 'var(--red)' : 'var(--surface2)';
      document.getElementById('tab-arquivo').style.color = tab==='arquivo' ? 'white' : 'var(--muted)';
      document.getElementById('tab-youtube').style.background = tab==='youtube' ? 'var(--red)' : 'var(--surface2)';
      document.getElementById('tab-youtube').style.color = tab==='youtube' ? 'white' : 'var(--muted)';
    }
    </script>
  `, '', 'midia');
}

module.exports = router;
