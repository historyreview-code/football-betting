const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));

// ==================== 数据 ====================
const rooms = new Map();
let nextRoomId = 1000;
let nextMatchId = 1;

function r(id) { return rooms.get(id); }
function w(room) { rooms.set(room.id, room); }

// ==================== API ====================

// 创建房间
app.post('/api/room', (req, res) => {
  const { creator } = req.body;
  if (!creator) return res.status(400).json({ err: '请输入昵称' });
  const id = String(nextRoomId++);
  w({
    id, creator,
    players: [{ name: creator, role: 'admin' }],
    matches: [], mSeq: 0,
    settled: new Set(),
    created: Date.now()
  });
  res.json({ id, players: [{ name: creator, role: 'admin' }], role: 'admin' });
});

// 加入房间
app.post('/api/room/:id/join', (req, res) => {
  const room = r(req.params.id);
  if (!room) return res.status(404).json({ err: '房间不存在' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ err: '请输入昵称' });
  if (room.players.find(p => p.name === name)) return res.status(409).json({ err: '该昵称已被使用' });
  room.players.push({ name, role: 'player' });
  res.json({ players: room.players, role: 'player' });
});

// 获取房间状态（公开所有人投注）
app.get('/api/room/:id', (req, res) => {
  const room = r(req.params.id);
  if (!room) return res.status(404).json({ err: '房间不存在' });
  res.json({
    id: room.id, creator: room.creator,
    players: room.players,
    matches: room.matches.map(m => ({
      id: m.id, home: m.home, away: m.away,
      result: m.result,
      settled: room.settled.has(m.id),
      bets: m.bets  // 完全公开
    }))
  });
});

// 添加比赛
app.post('/api/room/:id/match', (req, res) => {
  const room = r(req.params.id);
  if (!room) return res.status(404).json({ err: '房间不存在' });
  const { creator, home, away } = req.body;
  if (!home || !away) return res.status(400).json({ err: '请输入主客队名称' });
  if (!room.players.find(p => p.name === creator && p.role === 'admin')) 
    return res.status(403).json({ err: '仅管理员可操作' });
  const match = { id: String(++room.mSeq), home, away, result: null, bets: {} };
  room.matches.push(match);
  res.json({ match: { id: match.id, home, away } });
});

// 下注
app.post('/api/room/:id/bet', (req, res) => {
  const room = r(req.params.id);
  if (!room) return res.status(404).json({ err: '房间不存在' });
  const { player, matchId, home, draw, away } = req.body;
  if (!player || !matchId) return res.status(400).json({ err: '参数不足' });
  if (!room.players.find(p => p.name === player)) return res.status(403).json({ err: '你不是参与者' });
  const match = room.matches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ err: '比赛不存在' });
  if (room.settled.has(matchId)) return res.status(403).json({ err: '比赛已结算' });
  match.bets[player] = {
    home: Math.max(0, parseFloat(home) || 0),
    draw: Math.max(0, parseFloat(draw) || 0),
    away: Math.max(0, parseFloat(away) || 0)
  };
  res.json({ ok: true });
});

// 设置结果
app.post('/api/room/:id/result/:matchId', (req, res) => {
  const room = r(req.params.id);
  if (!room) return res.status(404).json({ err: '房间不存在' });
  const { creator, result } = req.body;
  if (!room.players.find(p => p.name === creator && p.role === 'admin'))
    return res.status(403).json({ err: '仅管理员可操作' });
  const match = room.matches.find(m => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ err: '比赛不存在' });
  match.result = result;
  res.json({ ok: true });
});

// 结算/重新开赛
app.post('/api/room/:id/settle/:matchId', (req, res) => {
  const room = r(req.params.id);
  if (!room) return res.status(404).json({ err: '房间不存在' });
  const { creator, action } = req.body; // action: 'settle' | 'unsettle'
  if (!room.players.find(p => p.name === creator && p.role === 'admin'))
    return res.status(403).json({ err: '仅管理员可操作' });
  const match = room.matches.find(m => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ err: '比赛不存在' });
  if (action === 'settle') {
    if (!match.result) return res.status(400).json({ err: '请先选择比赛结果' });
    room.settled.add(req.params.matchId);
  } else {
    match.result = null;
    room.settled.delete(req.params.matchId);
  }
  res.json({ ok: true });
});

// 清算
app.get('/api/room/:id/settlement', (req, res) => {
  const room = r(req.params.id);
  if (!room) return res.status(404).json({ err: '房间不存在' });
  const rep = {};
  for (const p of room.players) rep[p.name] = { bet: 0, win: 0, profit: 0, coeff: 0 };
  for (const m of room.matches) {
    if (!room.settled.has(m.id) || !m.result) continue;
    const pools = { home: 0, draw: 0, away: 0 };
    for (const b of Object.values(m.bets)) {
      pools.home += b.home||0; pools.draw += b.draw||0; pools.away += b.away||0;
    }
    const total = pools.home + pools.draw + pools.away;
    if (total === 0) continue;
    for (const [name, b] of Object.entries(m.bets)) {
      const pb = (b.home||0)+(b.draw||0)+(b.away||0);
      if (rep[name]) rep[name].bet += pb;
    }
    const winPool = pools[m.result], lossPool = total - winPool;
    for (const [name, b] of Object.entries(m.bets)) {
      if (!rep[name]) continue;
      const pb = (b.home||0)+(b.draw||0)+(b.away||0);
      if (pb === 0) continue;
      const pw = b[m.result]||0;
      let wb = pw;
      if (pw > 0 && winPool > 0) wb += (pw / winPool) * lossPool;
      rep[name].win += wb;
    }
  }
  for (const p of room.players) {
    const r = rep[p.name];
    r.profit = r.win - r.bet;
    r.coeff = r.bet > 0 ? Math.round((r.profit / r.bet) * 10000) / 10000 : 0;
  }
  res.json({ report: rep, players: room.players.map(p => p.name) });
});

// 健康检查
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ 足球投注服务器已启动: http://0.0.0.0:${PORT}`);
});
