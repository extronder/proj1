// Barbearia Marques - backend de agendamento
// Node >= 22.5, zero dependencias (usa node:sqlite e node:http)
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'troque-esta-senha';
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'marques.db');
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (!process.env.ADMIN_PASSWORD) console.warn('AVISO: defina ADMIN_PASSWORD. Usando senha padrao insegura.');
if (!process.env.SECRET) console.warn('AVISO: defina SECRET. Sem ele, o login do painel expira a cada reinicio.');

// ---- Regras do negocio (edite aqui) ----
const SERVICES = { 1: { n: 'Corte', p: 45 }, 2: { n: 'Barba', p: 35 }, 3: { n: 'Corte + Barba', p: 70 }, 4: { n: 'Sobrancelha', p: 15 }, 5: { n: 'Pigmentação', p: 40 } };
const BARBERS = ['Marques', 'Diego', 'Thiago'];
const HOURS = ['09:00','09:30','10:00','10:30','11:00','11:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30'];
const MAX_DAYS_AHEAD = 60;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, price INTEGER NOT NULL,
  barber TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL, name TEXT NOT NULL, tel TEXT NOT NULL,
  token TEXT NOT NULL, block INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(day, time, barber))`);

// ---- Utilitarios ----
function nowBR() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const mkToken = () => { const e = Date.now() + 12 * 3600e3; return e + '.' + sign('admin' + e); };
const okToken = t => {
  const [e, sg] = String(t || '').split('.');
  if (!e || !sg || +e < Date.now()) return false;
  const a = Buffer.from(sg), b = Buffer.from(sign('admin' + e));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const hits = new Map();
function limited(req, key, max) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = key + ip, now = Date.now(), arr = (hits.get(k) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 60000)) hits.delete(k); }, 60000).unref();

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' };
function send(res, code, obj) { res.writeHead(code, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((ok, no) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 10000) { no(new HttpError(413, 'Pedido muito grande.')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new HttpError(400, 'JSON inválido.')); } });
  });
}
const admin = req => { if (!okToken((req.headers.authorization || '').replace('Bearer ', ''))) throw new HttpError(401, 'Sessão expirada. Entre de novo.'); };
const validDay = d => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + 'T12:00:00Z'))) return 'Data inválida.';
  const t = nowBR(), diff = daysBetween(t.day, d);
  if (diff < 0) return 'Essa data já passou.';
  if (diff > MAX_DAYS_AHEAD) return 'Data muito distante.';
  if (new Date(d + 'T12:00:00Z').getUTCDay() === 0) return 'Fechado aos domingos.';
  return '';
};
const pub = r => ({ id: r.id, service: r.service, price: r.price, barber: r.barber, day: r.day, time: r.time });

// ---- Rotas da API ----
async function api(req, res, url) {
  const m = req.method, p = url.pathname;

  if (m === 'GET' && p === '/api/slots') {
    const day = url.searchParams.get('day') || '', barber = url.searchParams.get('barber') || '';
    if (!BARBERS.includes(barber)) throw new HttpError(400, 'Barbeiro inválido.');
    const e = validDay(day); if (e) throw new HttpError(400, e);
    const taken = db.prepare('SELECT time FROM bookings WHERE day=? AND barber=?').all(day, barber).map(r => r.time);
    return send(res, 200, { taken });
  }

  if (m === 'POST' && p === '/api/bookings') {
    if (limited(req, 'book', 10)) throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto.');
    const b = await readBody(req), svc = SERVICES[b.service];
    const name = String(b.name || '').trim(); let tel = String(b.tel || '').replace(/\D/g, '');
    if (tel.length > 11 && tel.startsWith('55')) tel = tel.slice(2);
    if (!svc) throw new HttpError(400, 'Serviço inválido.');
    if (!BARBERS.includes(b.barber)) throw new HttpError(400, 'Barbeiro inválido.');
    if (!HOURS.includes(b.time)) throw new HttpError(400, 'Horário inválido.');
    if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Informe seu nome.');
    if (tel.length < 10 || tel.length > 11) throw new HttpError(400, 'Informe um WhatsApp com DDD.');
    const e = validDay(String(b.day)); if (e) throw new HttpError(400, e);
    const t = nowBR(); const [hh, mm] = b.time.split(':');
    if (b.day === t.day && +hh * 60 + +mm <= t.min) throw new HttpError(400, 'Esse horário já passou.');
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const r = db.prepare('INSERT INTO bookings(service,price,barber,day,time,name,tel,token) VALUES(?,?,?,?,?,?,?,?)')
        .run(svc.n, svc.p, b.barber, b.day, b.time, name, tel, token);
      return send(res, 201, { ...pub({ id: Number(r.lastInsertRowid), service: svc.n, price: svc.p, barber: b.barber, day: b.day, time: b.time }), token });
    } catch (err) {
      if (/UNIQUE/.test(String(err.message))) throw new HttpError(409, 'Esse horário acabou de ser reservado. Escolha outro.');
      throw err;
    }
  }

  let mt = p.match(/^\/api\/bookings\/(\d+)$/);
  if (m === 'DELETE' && mt) {
    const r = db.prepare('SELECT token FROM bookings WHERE id=? AND block=0').get(+mt[1]);
    if (!r) throw new HttpError(404, 'Agendamento não encontrado.');
    if (!same(r.token, url.searchParams.get('token') || '')) throw new HttpError(403, 'Sem permissão.');
    db.prepare('DELETE FROM bookings WHERE id=?').run(+mt[1]);
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/admin/login') {
    if (limited(req, 'login', 5)) throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto.');
    const b = await readBody(req);
    if (!same(b.password || '', ADMIN_PASSWORD)) throw new HttpError(401, 'Senha incorreta.');
    return send(res, 200, { token: mkToken() });
  }

  if (m === 'GET' && p === '/api/admin/bookings') {
    admin(req);
    const rows = db.prepare('SELECT id,service,price,barber,day,time,name,tel,block FROM bookings WHERE day>=? ORDER BY day,time').all(nowBR().day);
    return send(res, 200, { bookings: rows });
  }

  mt = p.match(/^\/api\/admin\/bookings\/(\d+)$/);
  if (m === 'DELETE' && mt) { admin(req); db.prepare('DELETE FROM bookings WHERE id=?').run(+mt[1]); return send(res, 200, { ok: true }); }

  if (m === 'POST' && p === '/api/admin/block') {
    admin(req);
    const b = await readBody(req);
    if (!BARBERS.includes(b.barber) || !HOURS.includes(b.time)) throw new HttpError(400, 'Dados inválidos.');
    const e = validDay(String(b.day)); if (e) throw new HttpError(400, e);
    try {
      db.prepare("INSERT INTO bookings(service,price,barber,day,time,name,tel,token,block) VALUES('Bloqueado',0,?,?,?,'-','-','-',1)").run(b.barber, b.day, b.time);
    } catch (err) {
      if (/UNIQUE/.test(String(err.message))) throw new HttpError(409, 'Esse horário já está ocupado.');
      throw err;
    }
    return send(res, 201, { ok: true });
  }

  throw new HttpError(404, 'Rota não encontrada.');
}

// ---- Arquivos estaticos (pasta public) ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let f = path.normalize(path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res, url);
    throw new HttpError(405, 'Método não permitido.');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e); send(res, 500, { error: 'Erro interno. Tente novamente.' });
  }
}).listen(PORT, () => console.log('Barbearia Marques rodando na porta ' + PORT));
