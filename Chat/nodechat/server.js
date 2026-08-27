const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const app = express();
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// JSON File Database Layer
const DB_FILE = './database.json';
let db = { users: {}, servers: {}, dms: {}, friends: {}, bans: [] };

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE));
    } catch (e) { console.error("Database load error, initializing fresh DB."); }
  } else {
    saveDB();
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

loadDB();

// Helper for hashing passwords securely
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Browser Error Logger
app.post('/api/log-client-error', (req, res) => {
  const { message, source, lineno, error } = req.body;
  console.log(`\x1b[31m[BROWSER ERROR]\x1b[0m ${message} at ${source}:${lineno}`, error || '');
  res.sendStatus(200);
});

// Native Avatar File Upload Endpoint
app.post('/api/upload', (req, res) => {
  const rawData = req.body.image; // Base64 expected
  if (!rawData) return res.status(400).json({ error: 'No image data provided.' });
  try {
    const matches = rawData.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
    let buffer;
    let ext = 'png';
    if (matches && matches.length === 3) {
      ext = matches[1].includes('jpeg') || matches[1].includes('jpg') ? 'jpg' : 'png';
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(rawData, 'base64');
    }
    const filename = 'avatar_' + Math.random().toString(36).substr(2, 9) + '.' + ext;
    fs.writeFileSync(path.join(__dirname, 'uploads', filename), buffer);
    const fileUrl = `http://localhost:5000/uploads/${filename}`;
    res.json({ url: fileUrl });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save uploaded image.' });
  }
});

const clients = new Map(); // ws -> userId
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastSync() {
  const payload = JSON.stringify({ type: 'sync_trigger' });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

function sendToUser(userId, payload) {
  const payloadStr = JSON.stringify(payload);
  for (let [ws, clientUserId] of clients.entries()) {
    if (clientUserId === userId && ws.readyState === 1) {
      ws.send(payloadStr);
    }
  }
}

// REST Endpoints: Auth Management with Password Support
app.post('/api/auth/register', (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || username.trim().length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters long.' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
  }
  const cleanName = username.trim();
  
  if (db.bans && db.bans.includes(cleanName.toLowerCase())) {
    return res.status(403).json({ error: 'This username is platform-banned.' });
  }

  const exists = Object.values(db.users).some(u => u.username.toLowerCase() === cleanName.toLowerCase());
  if (exists) {
    // If user exists, treat registration attempt as a returning login validation
    const existingEntry = Object.entries(db.users).find(([t, u]) => u.username.toLowerCase() === cleanName.toLowerCase());
    if (existingEntry) {
      const [token, userObj] = existingEntry;
      if (userObj.password === hashPassword(password)) {
        console.log(`\x1b[32m[SERVER EVENT] Returning user authenticated:\x1b[0m ${cleanName}`);
        return res.json({ token, user: { id: userObj.id, username: userObj.username, avatar: userObj.avatar } });
      } else {
        return res.status(401).json({ error: 'Incorrect password for existing username.' });
      }
    }
    return res.status(400).json({ error: 'Username is already taken.' });
  }

  const userId = 'usr_' + Math.random().toString(36).substr(2, 9);
  const token = 'tok_' + Math.random().toString(36).substr(2, 9);
  
  db.users[token] = { 
    id: userId, 
    username: cleanName, 
    password: hashPassword(password),
    avatar: avatar || '', 
    bannedFrom: [] 
  };
  db.friends[userId] = [];
  saveDB();

  console.log(`\x1b[32m[SERVER EVENT] New user registered & authenticated:\x1b[0m ${cleanName} (${userId})`);
  res.json({ token, user: { id: userId, username: cleanName, avatar: avatar || '' } });
});

app.post('/api/auth/me', (req, res) => {
  const token = req.headers['authorization'];
  if (!token || !db.users[token]) return res.status(401).json({ error: 'Unauthorized' });
  const u = db.users[token];
  res.json({ id: u.id, username: u.username, avatar: u.avatar });
});

app.get('/api/sync', (req, res) => {
  const token = req.headers['authorization'];
  if (!token || !db.users[token]) return res.status(401).json({ error: 'Unauthorized' });
  
  const me = db.users[token];
  res.json({
    servers: db.servers,
    dms: db.dms,
    friends: db.friends[me.id] || [],
    users: Object.values(db.users).map(u => ({ id: u.id, username: u.username, avatar: u.avatar }))
  });
});

// WebSocket Core Engine
wss.on('connection', (ws) => {
  let authenticatedUserId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'auth') {
        const token = data.token;
        if (db.users[token]) {
          authenticatedUserId = db.users[token].id;
          clients.set(ws, authenticatedUserId);
          ws.send(JSON.stringify({ type: 'authenticated' }));
        }
        return;
      }

      if (!authenticatedUserId) return;
      const me = Object.values(db.users).find(u => u.id === authenticatedUserId);
      if (!me) return;

      switch (data.type) {
        case 'update_profile':
          if (data.username) me.username = data.username.trim();
          if (data.avatar !== undefined) me.avatar = data.avatar;
          saveDB();
          broadcastSync();
          break;

        case 'add_friend_by_username':
          const targetUser = Object.values(db.users).find(u => u.username.toLowerCase() === data.targetUsername.trim().toLowerCase());
          if (!targetUser) {
            ws.send(JSON.stringify({ type: 'error', message: 'User not found.' }));
            return;
          }
          if (targetUser.id === me.id) {
            ws.send(JSON.stringify({ type: 'error', message: "You can't add yourself." }));
            return;
          }
          if (!db.friends[me.id].includes(targetUser.id)) {
            db.friends[me.id].push(targetUser.id);
            if (!db.friends[targetUser.id]) db.friends[targetUser.id] = [];
            if (!db.friends[targetUser.id].includes(me.id)) db.friends[targetUser.id].push(me.id);
            saveDB();
            broadcastSync();
          }
          break;

        case 'create_server':
          if (!data.name || !data.name.trim()) return;
          const sId = 'srv_' + Math.random().toString(36).substr(2, 9);
          db.servers[sId] = {
            id: sId,
            name: data.name.trim(),
            ownerId: me.id,
            icon: data.icon || '',
            banner: data.banner || '',
            visibility: data.visibility || 'public', // public or private support
            channels: {
              "chan_gen": { id: "chan_gen", name: "general", messages: [] }
            }
          };
          saveDB();
          broadcastSync();
          break;

        case 'update_server':
          const srvUpdate = db.servers[data.serverId];
          if (srvUpdate && srvUpdate.ownerId === me.id) {
            if (data.name) srvUpdate.name = data.name.trim();
            if (data.icon !== undefined) srvUpdate.icon = data.icon;
            if (data.banner !== undefined) srvUpdate.banner = data.banner;
            if (data.visibility !== undefined) srvUpdate.visibility = data.visibility;
            saveDB();
            broadcastSync();
          }
          break;

        case 'delete_server':
          if (db.servers[data.serverId]?.ownerId === me.id) {
            delete db.servers[data.serverId];
            saveDB();
            broadcastSync();
          }
          break;

        case 'create_channel':
          const targetSrv = db.servers[data.serverId];
          if (targetSrv && targetSrv.ownerId === me.id && data.name) {
            const cId = 'chan_' + Math.random().toString(36).substr(2, 9);
            targetSrv.channels[cId] = { id: cId, name: data.name.toLowerCase().replace(/\s+/g, '-'), messages: [] };
            saveDB();
            broadcastSync();
          }
          break;

        case 'server_announcement':
          const annSrv = db.servers[data.serverId];
          if (annSrv && annSrv.ownerId === me.id && data.text) {
            for (let cId in annSrv.channels) {
              annSrv.channels[cId].messages.push({
                id: 'msg_' + Math.random().toString(36).substr(2, 9),
                userId: 'system',
                user: '📢 [ANNOUNCEMENT]',
                text: data.text.trim(),
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              });
            }
            saveDB();
            broadcastSync();
          }
          break;

        case 'kick_user':
          if (db.servers[data.serverId]?.ownerId === me.id && data.targetId !== me.id) {
            sendToUser(data.targetId, { type: 'notification', title: 'Server Action', body: `You were kicked from ${db.servers[data.serverId].name}` });
            broadcastSync();
          }
          break;

        case 'ban_user':
          if (db.servers[data.serverId]?.ownerId === me.id && data.targetId !== me.id) {
            const tUser = Object.values(db.users).find(u => u.id === data.targetId);
            if (tUser) {
              if (!tUser.bannedFrom) tUser.bannedFrom = [];
              tUser.bannedFrom.push(data.serverId);
              saveDB();
              sendToUser(data.targetId, { type: 'notification', title: 'Server Ban', body: `You were banned from ${db.servers[data.serverId].name}` });
              broadcastSync();
            }
          }
          break;

        case 'send_server_msg':
          const srv = db.servers[data.serverId];
          if (!srv || (me.bannedFrom && me.bannedFrom.includes(data.serverId))) return;
          const chan = srv.channels[data.channelId];
          if (chan && data.text && data.text.trim()) {
            const newMsg = {
              id: 'msg_' + Math.random().toString(36).substr(2, 9),
              userId: me.id,
              user: me.username,
              text: data.text.trim(),
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            chan.messages.push(newMsg);
            saveDB();
            broadcastSync();

            wss.clients.forEach(client => {
              client.send(JSON.stringify({ type: 'notify_client', title: `#${chan.name} (${srv.name})`, body: `${me.username}: ${newMsg.text}` }));
            });
          }
          break;

        case 'send_dm_msg':
          if (!data.text || !data.text.trim()) return;
          let dmId = [me.id, data.targetId].sort().join('_');
          if (!db.dms[dmId]) {
            db.dms[dmId] = { id: dmId, user1: me.id, user2: data.targetId, messages: [] };
          }
          const dmMsg = {
            id: 'msg_' + Math.random().toString(36).substr(2, 9),
            userId: me.id,
            user: me.username,
            text: data.text.trim(),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          db.dms[dmId].messages.push(dmMsg);
          saveDB();
          broadcastSync();

          sendToUser(data.targetId, { type: 'notify_client', title: `Direct Message from ${me.username}`, body: dmMsg.text });
          break;
      }
    } catch (e) { console.error("WS Error:", e); }
  });

  ws.on('close', () => clients.delete(ws));
});

// Interactive Server Console Admin CLI (Supports resetpass [user] [newpass])
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("\n\x1b[36m[ADMIN CLI READY]\x1b[0m Type commands: 'list', 'ban <username>', 'unban <username>', 'resetpass <username> <newpass>'");

rl.on('line', (line) => {
  const parts = line.trim().split(' ');
  const cmd = parts[0];
  const arg = parts[1];
  const arg2 = parts[2];

  if (cmd === 'list') {
    console.log("--- Registered Platform Users ---");
    Object.values(db.users).forEach(u => console.log(` - ID: ${u.id} | Username: ${u.username}`));
  } else if (cmd === 'ban' && arg) {
    const target = Object.values(db.users).find(u => u.username.toLowerCase() === arg.toLowerCase());
    if (target) {
      if (!db.bans) db.bans = [];
      db.bans.push(target.username.toLowerCase());
      delete db.users[Object.keys(db.users).find(k => db.users[k].id === target.id)];
      saveDB();
      console.log(`\x1b[31m[PLATFORM BAN APPLIED]\x1b[0m User '${target.username}' banned. Username freed for registration.`);
    } else {
      console.log("User not found.");
    }
  } else if (cmd === 'unban' && arg) {
    if (db.bans) {
      db.bans = db.bans.filter(b => b !== arg.toLowerCase());
      saveDB();
      console.log(`\x1b[32m[PLATFORM UNBAN APPLIED]\x1b[0m Username '${arg}' unbanned.`);
    }
  } else if (cmd === 'resetpass' && arg && arg2) {
    const targetEntry = Object.entries(db.users).find(([t, u]) => u.username.toLowerCase() === arg.toLowerCase());
    if (targetEntry) {
      const [token, userObj] = targetEntry;
      db.users[token].password = hashPassword(arg2);
      saveDB();
      console.log(`\x1b[32m[PASSWORD RESET SUCCESS]\x1b[0m Password updated for user '${userObj.username}'.`);
    } else {
      console.log("User not found.");
    }
  } else {
    console.log("Unknown command. Use 'list', 'ban <username>', 'unban <username>', 'resetpass <username> <newpass>'");
  }
});

server.listen(5000, () => console.log('NodeChat API engine running smoothly on port 5000'));