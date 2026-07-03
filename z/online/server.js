const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 数据层（内存，生产环境可替换为数据库） ====================
let rooms = {};
let nextRoomId = 1;

// ==================== 中间件 ====================
app.use(express.json());
app.use(express.static('public'));

// ==================== API ====================

// --- 房间管理 ---
app.post('/api/rooms', (req, res) => {
  const { name, creator } = req.body;
  if (!name || !creator) return res.status(400).json({ error: '需要房间名称和创建者' });
  
  const room = {
    id: String(nextRoomId++),
    name,
    creator,
    password: req.body.password || '',
    players: [{ name: creator, role: 'admin' }],
    matches: [],
    bets: {},     // { matchId: { playerName: { home, draw, away } } }
    result: {},   // { matchId: 'home' | 'draw' | 'away' | null }
    settled: {},  // { matchId: true | false }
    matchIdSeq: 0,
    status: 'open' // open | locked
  };
  
  rooms[room.id] = room;
  res.json({ roomId: room.id });
});

app.post('/api/rooms/join', (req, res) => {
  const { roomId, name, password } = req.body;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (room.password && room.password !== password) return res.status(403).json({ error: '密码错误' });
  if (room.status === 'locked') return res.status(403).json({ error: '房间已锁定' });
  if (room.players.find(p => p.name === name)) return res.status(409).json({ error: '该名称已被使用' });
  
  room.players.push({ name, role: 'player' });
  res.json({ roomId: room.id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  // 返回房间公开信息（不含密码）
  const { password, ...publicRoom } = room;
  res.json(publicRoom);
});

// --- 比赛管理 ---
app.post('/api/rooms/:id/matches', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  const { home, away, creator } = req.body;
  if (!home || !away) return res.status(400).json({ error: '需要主队和客队名称' });
  
  // 验证创建者权限
  const player = room.players.find(p => p.name === creator);
  if (!player || player.role !== 'admin') return res.status(403).json({ error: '只有管理员可以添加比赛' });
  
  const matchId = String(++room.matchIdSeq);
  room.matches.push({ id: matchId, home, away });
  room.bets[matchId] = {};
  room.result[matchId] = null;
  room.settled[matchId] = false;
  
  res.json({ matchId });
});

app.delete('/api/rooms/:id/matches/:matchId', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  const { creator } = req.body;
  const player = room.players.find(p => p.name === creator);
  if (!player || player.role !== 'admin') return res.status(403).json({ error: '只有管理员可以删除比赛' });
  
  room.matches = room.matches.filter(m => m.id !== req.params.matchId);
  delete room.bets[req.params.matchId];
  delete room.result[req.params.matchId];
  delete room.settled[req.params.matchId];
  
  res.json({ success: true });
});

// --- 投注 ---
app.post('/api/rooms/:id/bets', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  const { player, matchId, home, draw, away } = req.body;
  if (!player || !matchId) return res.status(400).json({ error: '需要参与者和比赛ID' });
  
  // 验证玩家在房间中
  if (!room.players.find(p => p.name === player)) return res.status(403).json({ error: '你不是该房间的参与者' });
  
  // 验证比赛存在
  const match = room.matches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  
  // 验证比赛未结算
  if (room.settled[matchId]) return res.status(403).json({ error: '比赛已结算，无法修改投注' });
  
  if (!room.bets[matchId]) room.bets[matchId] = {};
  room.bets[matchId][player] = {
    home: parseFloat(home) || 0,
    draw: parseFloat(draw) || 0,
    away: parseFloat(away) || 0
  };
  
  res.json({ success: true });
});

// --- 结果确认与结算（仅管理员）---
app.post('/api/rooms/:id/results/:matchId', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  const { result, creator } = req.body;
  const player = room.players.find(p => p.name === creator);
  if (!player || player.role !== 'admin') return res.status(403).json({ error: '只有管理员可以确认结果' });
  if (!['home', 'draw', 'away'].includes(result)) return res.status(400).json({ error: '无效的比赛结果' });
  
  room.result[req.params.matchId] = result;
  res.json({ success: true });
});

app.post('/api/rooms/:id/settle/:matchId', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  const { creator } = req.body;
  const player = room.players.find(p => p.name === creator);
  if (!player || player.role !== 'admin') return res.status(403).json({ error: '只有管理员可以结算比赛' });
  if (!room.result[req.params.matchId]) return res.status(400).json({ error: '请先确认比赛结果' });
  
  room.settled[req.params.matchId] = true;
  res.json({ success: true });
});

app.post('/api/rooms/:id/unsettle/:matchId', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  const { creator } = req.body;
  const player = room.players.find(p => p.name === creator);
  if (!player || player.role !== 'admin') return res.status(403).json({ error: '只有管理员可以操作' });
  
  room.settled[req.params.matchId] = false;
  room.result[req.params.matchId] = null;
  res.json({ success: true });
});

// --- 清算数据 ---
app.get('/api/rooms/:id/settlement', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  const report = {};
  for (const p of room.players) {
    report[p.name] = { totalBet: 0, totalWin: 0, netProfit: 0, coeff: 0 };
  }
  
  for (const match of room.matches) {
    const mid = match.id;
    if (!room.settled[mid] || !room.result[mid]) continue;
    
    const pools = { home: 0, draw: 0, away: 0 };
    const matchBets = room.bets[mid] || {};
    for (const b of Object.values(matchBets)) {
      pools.home += b.home || 0;
      pools.draw += b.draw || 0;
      pools.away += b.away || 0;
    }
    const totalPool = pools.home + pools.draw + pools.away;
    if (totalPool === 0) continue;
    
    for (const [player, b] of Object.entries(matchBets)) {
      const pb = (b.home||0)+(b.draw||0)+(b.away||0);
      if (report[player]) report[player].totalBet += pb;
    }
    
    const winOpt = room.result[mid];
    const winPool = pools[winOpt];
    const lossPool = totalPool - winPool;
    
    for (const [player, b] of Object.entries(matchBets)) {
      if (!report[player]) continue;
      const pb = (b.home||0)+(b.draw||0)+(b.away||0);
      if (pb === 0) continue;
      const pWinBet = b[winOpt]||0;
      let winBack = pWinBet;
      if (pWinBet > 0 && winPool > 0) {
        winBack += (pWinBet / winPool) * lossPool;
      }
      report[player].totalWin += winBack;
    }
  }
  
  for (const p of room.players) {
    const r = report[p.name];
    r.netProfit = r.totalWin - r.totalBet;
    r.coeff = r.totalBet > 0 ? Math.round((r.netProfit / r.totalBet) * 10000) / 10000 : 0;
  }
  
  res.json({ report, players: room.players.map(p => p.name) });
});

// ==================== 启动 ====================
// healthcheck
app.get("/api/rooms/health", (req,res) => res.json({status:"ok"}));

app.listen(PORT, () => {
  console.log(`⚽ 足球投注服务器已启动: http://localhost:${PORT}`);
});
