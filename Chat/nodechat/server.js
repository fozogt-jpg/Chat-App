const express = require('express');
const http = require('http');
const { Server } = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(cors());
app.use(express.json({ limit: '5mb' })); // Support base64 image avatar uploads

// Initialize Persistent SQLite Database
const dbFile = path.join(__dirname, 'nodechat.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected to persistent SQLite database.');
});

// Create Tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        isPublic INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        username TEXT,
        password TEXT,
        avatar TEXT,
        UNIQUE(server_id, username)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        username TEXT,
        text TEXT,
        avatar TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// CLI Command Handler for Admin Password Reset: node server.js resetpass <username> <newpass>
if (process.argv[2] === 'resetpass') {
    const [, , , targetUser, newPass] = process.argv;
    if (!targetUser || !newPass) {
        console.log('Usage: node server.js resetpass <username> <newpass>');
        process.exit(1);
    }
    db.run(`UPDATE users SET password = ? WHERE username = ?`, [newPass, targetUser], function(err) {
        if (err) console.error('Error resetting password:', err.message);
        else console.log(`Password successfully reset for user: ${targetUser} (${this.changes} rows updated).`);
        process.exit(0);
    });
    return;
}

// REST API Endpoints

// Get all public servers (and check specific private server by name)
app.get('/api/servers', (req, res) => {
    const { lookup } = req.query;
    if (lookup) {
        db.get(`SELECT * FROM servers WHERE name = ?`, [lookup], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(row || { error: 'Server not found' });
        });
    } else {
        db.all(`SELECT * FROM servers WHERE isPublic = 1`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    }
});

// Create a new server
app.post('/api/servers', (req, res) => {
    const { name, isPublic } = req.body;
    if (!name) return res.status(400).json({ error: 'Server name is required' });
    
    db.run(`INSERT OR IGNORE INTO servers (id, name, isPublic) VALUES (?, ?, ?)`, 
        [name.toLowerCase().replace(/\s+/g, '-'), name, isPublic ? 1 : 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, serverId: name.toLowerCase().replace(/\s+/g, '-'), name });
    });
});

// Authenticate or Register user for a specific backend/server
app.post('/api/auth', (req, res) => {
    const { serverId, username, password, avatar } = req.body;
    if (!serverId || !username || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    db.get(`SELECT * FROM users WHERE server_id = ? AND username = ?`, [serverId, username], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });

        if (user) {
            // Existing user: verify password
            if (user.password === password) {
                // Update avatar if provided
                if (avatar) {
                    db.run(`UPDATE users SET avatar = ? WHERE server_id = ? AND username = ?`, [avatar, serverId, username]);
                }
                res.json({ success: true, message: 'Logged in successfully', avatar: avatar || user.avatar });
            } else {
                res.status(401).json({ error: 'Incorrect password for this username.' });
            }
        } else {
            // New user on this backend: register them
            db.run(`INSERT INTO users (server_id, username, password, avatar) VALUES (?, ?, ?, ?)`,
                [serverId, username, password, avatar || ''], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, message: 'Account created successfully', avatar: avatar || '' });
            });
        }
    });
});

// Update user settings (Username/Password/Avatar)
app.post('/api/user/update', (req, res) => {
    const { serverId, oldUsername, newUsername, password, avatar } = req.body;
    db.run(`UPDATE users SET username = ?, password = ?, avatar = ? WHERE server_id = ? AND username = ?`,
        [newUsername, password, avatar, serverId, oldUsername], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Get chat history for a server
app.get('/api/messages/:serverId', (req, res) => {
    db.all(`SELECT * FROM messages WHERE server_id = ? ORDER BY timestamp ASC LIMIT 100`, [req.params.serverId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// WebSocket Real-time Messaging
wss.on('connection', (ws) => {
    let currentServer = null;

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        if (data.type === 'join') {
            currentServer = data.serverId;
            ws.serverId = currentServer;
        } else if (data.type === 'chat') {
            const { serverId, username, text, avatar } = data;
            db.run(`INSERT INTO messages (server_id, username, text, avatar) VALUES (?, ?, ?, ?)`,
                [serverId, username, text, avatar], (err) => {
                    if (!err) {
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.serverId === serverId) {
                                client.send(JSON.stringify({ type: 'chat', username, text, avatar, timestamp: new Date() }));
                            }
                        });
                    }
                });
        }
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`NodeChat Backend running on http://localhost:${PORT}`);
});