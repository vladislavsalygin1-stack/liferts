const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const BIN_ID = '6b02d2e6ffd5d16053d580c8';
const API_KEY = '$2a$10$U/UgbwFhcxSpyvUeUbc3nedSh5Ii8u0lojDrK1Bclv30dv4ol6fHm';


const BLOCK_COST = 3;
const CORE_COST = 150;
const CORE_MAX_HP = 100;
const DEMOLISH_TICKS = 10;
const PALETTE = [0x38bdf8, 0xef4444, 0xa855f7, 0xf97316, 0xec4899, 0x14b8a6, 0xeab308, 0x6366f1];

let cells = [];
let cores = [];
let builds = [];
let demos = [];
let players = [];
let generatedChunks = new Set();
let teamRequests = [];

async function loadWorldData() {
  try {
        const res = await fetch('https://' + 'api.jsonbin.io/v3/b/' + BIN_ID + '/latest', {
      headers: { 'X-Master-Key': API_KEY }
    });
    const json = await res.json();
    const data = json.record || {};
    players = (data.players || []).map(p => ({ team: '', teamLeader: false, ...p }));
    cores = data.cores || [];
    if (Array.isArray(data.walls)) cells.push(...data.walls);
    console.log('Мир загружен из облака! Игроков:', players.length, 'Ядер:', cores.length);
  } catch (e) { console.error('Ошибка чтения из облака:', e); }
}

let saveTimer = null;
function saveWorldData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
                   const r = await fetch('https://' + 'api.jsonbin.io/v3/b/' + BIN_ID, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': API_KEY
        },
        body: JSON.stringify({
          players,
          cores,
          walls: cells.filter(c => c[2] === 2)
        })
      });
            console.log('JSONBin:', r.status, await r.text());
    } catch (e) { console.error('Ошибка записи в облако:', e); }
  }, 2000);
}

const isAlly = (pidA, pidB) => {
  if (pidA === pidB) return true;
  const pA = players[pidA], pB = players[pidB];
  return !!(pA && pB && pA.team && pA.team === pB.team);
};

const hasAnyCore = pid => cores.some(c => c.owner === pid);
const isInsidePlayerZone = (pid, x, y) => cores.some(c => isAlly(pid, c.owner) && Math.abs(x - c.x) <= 12 && Math.abs(y - c.y) <= 12);
const findCoreAt = (x, y) => cores.findIndex(c => Math.abs(x - c.x) <= 1 && Math.abs(y - c.y) <= 1);
const findCellIndex = (x, y) => cells.findIndex(c => c[0] === x && c[1] === y);

function ensureChunk(x, y) {
  const cx = Math.floor(x / 16);
  const cy = Math.floor(y / 16);
  const key = cx + ',' + cy;
  if (generatedChunks.has(key)) return;
  if (generatedChunks.size > 2000) generatedChunks.clear();
  generatedChunks.add(key);

  const seed = Math.abs((cx * 73856093) ^ (cy * 19349663));
  if ((seed % 100) < 55) {
    const rx = cx * 16 + 4 + (seed % 8);
    const ry = cy * 16 + 4 + ((seed >> 4) % 8);
    const hp = 50 + (seed % 80);
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        if (findCoreAt(rx + dc, ry + dr) === -1 && findCellIndex(rx + dc, ry + dr) === -1) {
          cells.push([rx + dc, ry + dr, 5, 255, hp]);
        }
      }
    }
  }
}

function absorbShip(startX, startY, owner, crystalX, crystalY) {
  const q = [[startX, startY]];
  const firstIdx = findCellIndex(startX, startY);
  if (firstIdx >= 0) cells.splice(firstIdx, 1);

  while (q.length > 0) {
    const cIdx = findCellIndex(crystalX, crystalY);
    if (cIdx === -1 || cells[cIdx][2] !== 5 || cells[cIdx][4] <= 0) break;
    const [cx, cy] = q.pop();
    cells[cIdx][4]--;
    if (players[owner]) players[owner].res += 4;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ni = findCellIndex(cx + dx, cy + dy);
        if (ni >= 0 && cells[ni][2] === 1 && isAlly(cells[ni][3], owner)) {
          q.push([cells[ni][0], cells[ni][1]]);
          cells.splice(ni, 1);
        }
      }
    }
  }
  const finalCIdx = findCellIndex(crystalX, crystalY);
  if (finalCIdx >= 0 && cells[finalCIdx][2] === 5 && cells[finalCIdx][4] <= 0) {
    cells.splice(finalCIdx, 1);
  }
}

function stepWorld() {
  for (let i = builds.length - 1; i >= 0; i--) {
    if (builds[i].ticksLeft > 0) builds[i].ticksLeft--;
    if (builds[i].ticksLeft === 0) {
      for (const [bx, by] of builds[i].pts) {
        const ci = findCellIndex(bx, by);
        if (ci >= 0 && cells[ci][2] === 3) {
          cells[ci][2] = builds[i].type || 1;
          if (cells[ci][2] === 2) saveWorldData();
        }
      }
      builds.splice(i, 1);
    }
  }

  for (let i = demos.length - 1; i >= 0; i--) {
    if (demos[i].ticksLeft > 0) demos[i].ticksLeft--;
    if (demos[i].ticksLeft === 0) {
      const d = demos[i];
      const ci = findCellIndex(d.x, d.y);
      if (ci >= 0 && cells[ci][2] === 4) {
        cells.splice(ci, 1);
        if (d.refund && players[d.owner]) players[d.owner].res += 1;
        saveWorldData();
      }
      demos.splice(i, 1);
    }
  }

  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i];
    if (!cell || cell[2] !== 1) continue;
    const [x, y, , owner] = cell;
    ensureChunk(x, y);

    const hitCore = findCoreAt(x, y);
    if (hitCore >= 0 && !isAlly(cores[hitCore].owner, owner)) {
      cells.splice(i, 1);
      if (cores[hitCore].hp > 1) {
        cores[hitCore].hp--;
      } else {
        cores[hitCore].owner = owner;
        cores[hitCore].hp = Math.floor(CORE_MAX_HP / 2);
        saveWorldData();
      }
      continue;
    }

    let hitWall = false;
    for (let dx = -1; dx <= 1 && !hitWall; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const wi = findCellIndex(x + dx, y + dy);
        if (wi >= 0 && (cells[wi][2] === 2 || cells[wi][2] === 3) && !isAlly(cells[wi][3], owner)) {
          cells.splice(i, 1);
          const wallIdx = findCellIndex(x + dx, y + dy);
          if (wallIdx >= 0) {
            cells[wallIdx][4]--;
            if (cells[wallIdx][4] <= 0) {
              cells.splice(wallIdx, 1);
              saveWorldData();
            }
          }
          i = cells.length;
          hitWall = true;
          break;
        }
      }
    }
    if (hitWall) continue;

    let absorbed = false;
    for (let dx = -1; dx <= 1 && !absorbed; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ci = findCellIndex(x + dx, y + dy);
        if (ci >= 0 && cells[ci][2] === 5) {
          absorbShip(x, y, owner, cells[ci][0], cells[ci][1]);
          i = cells.length;
          absorbed = true;
          break;
        }
      }
    }
  }

  const nextCells = cells.filter(c => c[2] >= 2);
  const liveMap = new Map();
  const candidates = new Set();

  for (const c of cells) {
    if (c[2] !== 1) continue;
    const [x, y, , owner] = c;
    liveMap.set(x + ',' + y, owner);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = x + dx, ny = y + dy;
        if (Math.abs(nx) <= 2000 && Math.abs(ny) <= 2000) candidates.add(nx + ',' + ny);
      }
    }
  }

  const staticSet = new Set(nextCells.map(c => c[0] + ',' + c[1]));

  for (const key of candidates) {
    if (staticSet.has(key)) continue;
    const [x, y] = key.split(',').map(Number);
    let count = 0;
    const ownerCounts = {};
    let domOwner = 0, maxCount = 0;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nOwner = liveMap.get((x + dx) + ',' + (y + dy));
        if (nOwner !== undefined) {
          count++;
          ownerCounts[nOwner] = (ownerCounts[nOwner] || 0) + 1;
          if (ownerCounts[nOwner] >= maxCount) { maxCount = ownerCounts[nOwner]; domOwner = nOwner; }
        }
      }
    }

    if (liveMap.has(key)) {
      if (count === 2 || count === 3) nextCells.push([x, y, 1, liveMap.get(key), 1]);
    } else if (count === 3) {
      nextCells.push([x, y, 1, domOwner, 1]);
    }
  }
  cells = nextCells;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.pid = -1;

  ws.on('message', msg => {
    const txt = msg.toString();
    if (txt.startsWith('AUTH|')) {
      const [, loginRaw, passRaw] = txt.split('|');
      const login = (loginRaw || '').trim().slice(0, 16);
      const pass = (passRaw || '').trim();
      if (login.length < 2) return;

      let found = players.findIndex(p => p.name === login);
      if (found === -1) {
        players.push({ name: login, pass, color: PALETTE[players.length % 8], res: 60, team: '', teamLeader: false });
        found = players.length - 1;
        saveWorldData();
      } else if (players[found].pass !== pass) {
        ws.send(JSON.stringify({ t: 'err', m: 'Неверный пароль!' }));
        return;
      }
      ws.pid = found;
      console.log(`[ВХОД] ${login} (Всего игроков: ${players.length})`);
      ws.send(JSON.stringify({ t: 'ok' }));
    }
    else if (txt.startsWith('COLOR|') && ws.pid >= 0) {
      const hex = parseInt(txt.split('|')[1], 16);
      if (!isNaN(hex)) {
        const meObj = players[ws.pid];
        meObj.color = hex;
        if (meObj.team) {
          players.forEach(p => { if (p.team === meObj.team) p.color = hex; });
        }
        saveWorldData();
      }
    }
    else if (txt.startsWith('GIVE|') && ws.pid >= 0) {
      const [, pass, amountRaw] = txt.split('|');
      if (pass === '999666777') {
        const amount = parseInt(amountRaw, 10) || 1000;
        players[ws.pid].res += amount;
        saveWorldData();
      }
    }
    else if (txt.startsWith('STATS|') && ws.pid >= 0) {
      const [, pass] = txt.split('|');
      if (pass === '999666777') {
        const online = [...wss.clients].filter(c => c.pid >= 0).map(c => players[c.pid]?.name);
        const all = players.map(p => `${p.name} (ресов: ${p.res})`);
        ws.send(JSON.stringify({ t: 'stats', online, all }));
      }
    }
    else if (txt.startsWith('TEAM|') && ws.pid >= 0) {
      const tag = (txt.split('|')[1] || '').trim().replace(/[^a-zA-Zа-яА-Я0-9]/g, '').slice(0, 5).toUpperCase();
      const meObj = players[ws.pid];

      if (!tag) {
        const oldTeam = meObj.team;
        const wasLeader = meObj.teamLeader;
        meObj.team = '';
        meObj.teamLeader = false;
        if (oldTeam && wasLeader) {
          const nextMember = players.find(p => p.team === oldTeam);
          if (nextMember) nextMember.teamLeader = true;
          else teamRequests = teamRequests.filter(r => r.tag !== oldTeam);
        }
        saveWorldData();
        return;
      }

      const members = players.filter(p => p.team === tag);
      if (members.length === 0) {
        meObj.team = tag;
        meObj.teamLeader = true;
        saveWorldData();
        ws.send(JSON.stringify({ t: 'err', m: 'Команда [' + tag + '] создана! Вы лидер.' }));
      } else {
        if (meObj.team === tag) return;
        teamRequests = teamRequests.filter(r => !(r.from === meObj.name && r.tag === tag));
        teamRequests.push({ from: meObj.name, tag });
        ws.send(JSON.stringify({ t: 'err', m: 'Заявка в команду [' + tag + '] отправлена лидеру!' }));
      }
    }
    else if (txt.startsWith('TEAM_ACC|') && ws.pid >= 0) {
      const targetName = (txt.split('|')[1] || '').trim();
      const meObj = players[ws.pid];
      if (!meObj.team || !meObj.teamLeader) return;
      const reqIdx = teamRequests.findIndex(r => r.from === targetName && r.tag === meObj.team);
      if (reqIdx === -1) return;
      teamRequests.splice(reqIdx, 1);

      const candidate = players.find(p => p.name === targetName);
      if (candidate) {
        candidate.team = meObj.team;
        candidate.teamLeader = false;
        candidate.color = meObj.color;
        saveWorldData();
      }
    }
    else if (txt.startsWith('TEAM_REJ|') && ws.pid >= 0) {
      const targetName = (txt.split('|')[1] || '').trim();
      const meObj = players[ws.pid];
      if (!meObj.team || !meObj.teamLeader) return;
      teamRequests = teamRequests.filter(r => !(r.from === targetName && r.tag === meObj.team));
    }
    else if (txt.startsWith('PAY|') && ws.pid >= 0) {
      const [, targetNameRaw, amtStr] = txt.split('|');
      const targetName = (targetNameRaw || '').trim();
      const amt = Math.floor(Number(amtStr));
      const sender = players[ws.pid];
      const receiver = players.find(p => p.name === targetName);
      if (!receiver || receiver === sender) {
        ws.send(JSON.stringify({ t: 'err', m: 'Игрок не найден!' }));
        return;
      }
      if (isNaN(amt) || amt <= 0 || sender.res < amt) {
        ws.send(JSON.stringify({ t: 'err', m: 'Недостаточно 💎 для перевода!' }));
        return;
      }
      sender.res -= amt;
      receiver.res += amt;
      saveWorldData();
      ws.send(JSON.stringify({ t: 'err', m: 'Переведено ' + amt + '💎 игроку ' + receiver.name + '!' }));
    }
    else if (txt.startsWith('CORE|') && ws.pid >= 0) {
      const [, bxStr, byStr] = txt.split('|');
      const bx = parseInt(bxStr), by = parseInt(byStr);
      const firstBase = !hasAnyCore(ws.pid);
      if (!firstBase && players[ws.pid].res < CORE_COST) {
        ws.send(JSON.stringify({ t: 'err', m: 'Нужно 150💎 для нового Ядра!' }));
        return;
      }
      if (cores.some(c => Math.abs(c.x - bx) < 14 && Math.abs(c.y - by) < 14)) return;
      if (!firstBase) players[ws.pid].res -= CORE_COST;
      cores.push({ owner: ws.pid, x: bx, y: by, hp: CORE_MAX_HP, isMain: firstBase });
      for (let dx = -16; dx <= 16; dx += 16)
        for (let dy = -16; dy <= 16; dy += 16)
          ensureChunk(bx + dx, by + dy);
      saveWorldData();
    }
    else if (txt.startsWith('BUILD|') && ws.pid >= 0) {
      const [, ticksStr, coords] = txt.split('|');
      const ticks = Math.max(1, parseInt(ticksStr) || 1);
      const pts = [];
      for (const pair of (coords || '').split(';')) {
        if (!pair.includes(',')) continue;
        const [x, y] = pair.split(',').map(Number);
        if (!isInsidePlayerZone(ws.pid, x, y) || findCellIndex(x, y) !== -1 || findCoreAt(x, y) !== -1) return;
        pts.push([x, y]);
      }
      const totalCost = pts.length * BLOCK_COST;
      if (pts.length === 0 || players[ws.pid].res < totalCost) return;
      players[ws.pid].res -= totalCost;
      for (const [x, y] of pts) cells.push([x, y, 3, ws.pid, 1]);
      builds.push({ owner: ws.pid, ticksLeft: ticks, pts });
    }
    else if (txt.startsWith('WALL|') && ws.pid >= 0) {
      if (players[ws.pid].res < 2) return;
      const [, xStr, yStr] = txt.split('|');
      const x = parseInt(xStr), y = parseInt(yStr);
      if (!isInsidePlayerZone(ws.pid, x, y) || findCellIndex(x, y) !== -1 || findCoreAt(x, y) !== -1) return;
      players[ws.pid].res -= 2;
      cells.push([x, y, 3, ws.pid, 5]);
      builds.push({ owner: ws.pid, ticksLeft: 50, pts: [[x, y]], type: 2 });
    }
    else if (txt.startsWith('DEL|') && ws.pid >= 0) {
      const [, xStr, yStr] = txt.split('|');
      const x = parseInt(xStr), y = parseInt(yStr);
      if (!isInsidePlayerZone(ws.pid, x, y)) return;
      const ci = findCellIndex(x, y);
      if (ci >= 0 && isAlly(cells[ci][3], ws.pid) && (cells[ci][2] === 1 || cells[ci][2] === 2)) {
        const isWall = cells[ci][2] === 2;
        cells[ci][2] = 4;
        demos.push({ owner: ws.pid, x, y, ticksLeft: DEMOLISH_TICKS, refund: isWall });
      }
    }
  });
});

(async () => {
  await loadWorldData();
  for (let x = -32; x <= 32; x += 16)
    for (let y = -32; y <= 32; y += 16)
      ensureChunk(x, y);

  setInterval(() => {
    stepWorld();

    const outCells = cells.map(c => {
      const col = players[c[3]] ? players[c[3]].color : 0x10b981;
      return [c[0], c[1], c[2], col, c[4]];
    });
    const outCores = cores.map(b => {
      const ownerObj = players[b.owner];
      const dispName = ownerObj ? (ownerObj.team ? '[' + ownerObj.team + '] ' + ownerObj.name : ownerObj.name) : '?';
      return {
        n: dispName,
        x: b.x, y: b.y, hp: b.hp,
        c: ownerObj ? ownerObj.color : 0xffffff
      };
    });
    const pList = players.map(p => ({ n: p.name, t: p.team }));
    const stateMsg = JSON.stringify({ t: 'state', cells: outCells, cores: outCores, players: pList });

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(stateMsg);
        if (client.pid >= 0 && players[client.pid]) {
          const meObj = players[client.pid];
          const myCore = cores.find(c => c.owner === client.pid);
          const myReqs = (meObj.team && meObj.teamLeader)
            ? teamRequests.filter(r => r.tag === meObj.team).map(r => r.from)
            : [];
          client.send(JSON.stringify({
            t: 'me',
            name: meObj.name,
            team: meObj.team,
            isLeader: !!meObj.teamLeader,
            reqs: myReqs,
            color: meObj.color,
            res: meObj.res,
            hasBase: !!myCore,
            bx: myCore ? myCore.x : 0,
            by: myCore ? myCore.y : 0
          }));
        }
      }
    });
  }, 200);

  server.listen(PORT, '0.0.0.0', () => console.log('Сервер LifeRTS запущен на порту ' + PORT));
})();
