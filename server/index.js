import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db, { initDatabase } from './database.js';

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'melo_secret_token_key_2026';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../dist');

// Initialize SQLite tables
initDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Support base64 image uploads
app.use(express.static(clientDistPath));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
});

// Middleware to authenticate JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}

// ----------------------------------------------------
// AUTH ENDPOINTS
// ----------------------------------------------------

app.post('/api/auth/login-register', (req, res) => {
    const { phone, email, password } = req.body;
    let user = null;

    if (phone) {
        user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
        if (!user) {
            // Register new phone user
            const newId = 'user_' + Date.now();
            const username = 'user_' + Math.floor(1000 + Math.random() * 9000);
            db.prepare('INSERT INTO users (id, phone, name, username, interests, languages) VALUES (?, ?, ?, ?, ?, ?)')
              .run(newId, phone, 'Guest User', username, '[]', '[]');
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
        }
    } else if (email) {
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!user) {
            // Register new email user
            const newId = 'user_' + Date.now();
            const username = email.split('@')[0] + Math.floor(100 + Math.random() * 900);
            const passHash = bcrypt.hashSync(password || 'melo1234', 10);
            db.prepare('INSERT INTO users (id, email, password_hash, name, username, interests, languages) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(newId, email, passHash, email.split('@')[0], username, '[]', '[]');
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
        } else if (password) {
            // Login verify password
            if (user.password_hash && !bcrypt.compareSync(password, user.password_hash)) {
                return res.status(400).json({ error: 'Invalid credentials password.' });
            }
        }
    } else {
        return res.status(400).json({ error: 'Auth credentials required.' });
    }

    // Format interests & languages lists
    user.interests = JSON.parse(user.interests || '[]');
    user.languages = JSON.parse(user.languages || '[]');

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
});

app.post('/api/auth/profile', authenticateToken, (req, res) => {
    const { name, username, avatar, bio, interests, languages, city, dob, gender } = req.body;
    
    try {
        db.prepare(`
            UPDATE users 
            SET name = ?, username = ?, avatar = ?, bio = ?, interests = ?, languages = ?, city = ?, dob = ?, gender = ?
            WHERE id = ?
        `).run(
            name, 
            username, 
            avatar, 
            bio, 
            JSON.stringify(interests || []), 
            JSON.stringify(languages || []), 
            city, 
            dob, 
            gender, 
            req.user.id
        );
        
        const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        updatedUser.interests = JSON.parse(updatedUser.interests || '[]');
        updatedUser.languages = JSON.parse(updatedUser.languages || '[]');
        
        res.json({ success: true, user: updatedUser });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already taken.' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.interests = JSON.parse(user.interests || '[]');
    user.languages = JSON.parse(user.languages || '[]');
    res.json(user);
});

app.get('/api/users/:username', authenticateToken, (req, res) => {
    const user = db.prepare('SELECT id, name, username, avatar, bio, interests, languages, city FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.status(404).json({ error: 'Profile not found' });
    
    user.interests = JSON.parse(user.interests || '[]');
    user.languages = JSON.parse(user.languages || '[]');
    res.json(user);
});

// ----------------------------------------------------
// GATHERINGS ENDPOINTS
// ----------------------------------------------------

app.get('/api/gatherings', authenticateToken, (req, res) => {
    const { search, category, date, public: isPub, age18, smallGroup } = req.query;
    
    // Check blocked users list to filter events
    const blockedRecords = db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(req.user.id);
    const blockedByUser = blockedRecords.map(r => r.blocked_id);
    
    const blockersRecords = db.prepare('SELECT blocker_id FROM blocks WHERE blocked_id = ?').all(req.user.id);
    const blockersOfUser = blockersRecords.map(r => r.blocker_id);
    const excludedHosts = [...blockedByUser, ...blockersOfUser];

    let query = 'SELECT * FROM gatherings WHERE status = ?';
    let params = ['active'];

    if (excludedHosts.length > 0) {
        query += ` AND hostId NOT IN (${excludedHosts.map(() => '?').join(',')})`;
        params.push(...excludedHosts);
    }

    let results = db.prepare(query).all(...params);

    // Apply SQL simulation filters
    if (search) {
        const q = search.toLowerCase();
        results = results.filter(g => 
            g.title.toLowerCase().includes(q) || 
            g.description.toLowerCase().includes(q) || 
            g.location.toLowerCase().includes(q)
        );
    }
    if (category) {
        results = results.filter(g => g.category.toLowerCase() === category.toLowerCase());
    }
    if (date) {
        const todayStr = "2026-08-07";
        const tmrwStr = "2026-08-08";
        if (date === "today") results = results.filter(g => g.date === todayStr);
        else if (date === "tomorrow") results = results.filter(g => g.date === tmrwStr);
        else if (date === "weekend") {
            results = results.filter(g => {
                const day = new Date(g.date).getDay();
                return day === 0 || day === 6;
            });
        }
    }
    if (isPub !== undefined) {
        const val = isPub === 'true' ? 1 : 0;
        results = results.filter(g => g.public === val);
    }
    if (age18 === 'true') {
        results = results.filter(g => g.ageRestriction.includes("18+") || g.ageRestriction.includes("21+"));
    }
    if (smallGroup === 'true') {
        results = results.filter(g => g.maxAttendees <= 10);
    }

    // Attach host profile & attendees count
    const mapped = results.map(g => {
        const host = db.prepare('SELECT id, name, username, avatar FROM users WHERE id = ?').get(g.hostId);
        const attendeesCount = db.prepare('SELECT count(*) as count FROM attendees WHERE gathering_id = ?').get(g.id).count;
        const attendeesList = db.prepare('SELECT user_id FROM attendees WHERE gathering_id = ?').all(g.id).map(r => r.user_id);
        const requestsList = db.prepare('SELECT user_id FROM join_requests WHERE gathering_id = ? AND status = ?').all(g.id, 'pending').map(r => r.user_id);
        
        return {
            ...g,
            public: g.public === 1,
            tags: JSON.parse(g.tags || '[]'),
            host,
            attendeeCount: attendeesCount,
            attendees: attendeesList,
            requests: requestsList,
            distance: "1.2 miles away"
        };
    });

    res.json(mapped);
});

app.post('/api/gatherings', authenticateToken, (req, res) => {
    const { title, description, category, date, time, endTime, venue, location, maxAttendees, public: isPub, ageRestriction, dressCode, itemsToBring, rules, coverImage, tags } = req.body;
    
    const statement = db.prepare(`
        INSERT INTO gatherings (title, description, category, date, time, endTime, venue, location, maxAttendees, public, ageRestriction, dressCode, itemsToBring, rules, coverImage, tags, hostId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = statement.run(
        title,
        description,
        category,
        date,
        time,
        endTime,
        venue,
        location,
        maxAttendees,
        isPub ? 1 : 0,
        ageRestriction,
        dressCode,
        itemsToBring,
        rules,
        coverImage,
        JSON.stringify(tags || []),
        req.user.id
    );

    const newId = result.lastInsertRowid;
    // Add Host as attendee automatically
    db.prepare('INSERT INTO attendees (gathering_id, user_id) VALUES (?, ?)').run(newId, req.user.id);

    res.json({ success: true, id: newId });
});

app.get('/api/gatherings/:id', authenticateToken, (req, res) => {
    const event = db.prepare('SELECT * FROM gatherings WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Gathering not found' });

    event.public = event.public === 1;
    event.tags = JSON.parse(event.tags || '[]');
    
    // Fetch Host
    const host = db.prepare('SELECT id, name, username, avatar, bio FROM users WHERE id = ?').get(event.hostId);
    
    // Fetch Attendees
    const attendeeRecords = db.prepare(`
        SELECT u.id, u.name, u.username, u.avatar 
        FROM attendees a 
        JOIN users u ON a.user_id = u.id 
        WHERE a.gathering_id = ?
    `).all(event.id);

    // Fetch Join Requests
    const requestRecords = db.prepare('SELECT user_id FROM join_requests WHERE gathering_id = ? AND status = ?').all(event.id, 'pending').map(r => r.user_id);

    // Fetch Comments
    const commentRecords = db.prepare(`
        SELECT c.text, c.created_at, u.name as userName, u.avatar as userAvatar 
        FROM comments c 
        JOIN users u ON c.user_id = u.id 
        WHERE c.gathering_id = ? 
        ORDER BY c.id ASC
    `).all(event.id);
    const comments = commentRecords.map(c => ({
        userName: c.userName,
        userAvatar: c.userAvatar,
        text: c.text,
        time: 'Just now'
    }));

    res.json({
        ...event,
        host,
        attendeesList: attendeeRecords,
        attendees: attendeeRecords.map(a => a.id),
        requests: requestRecords,
        comments
    });
});

app.delete('/api/gatherings/:id', authenticateToken, (req, res) => {
    const event = db.prepare('SELECT hostId FROM gatherings WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    if (event.hostId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    db.prepare('DELETE FROM gatherings WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

app.post('/api/gatherings/:id/complete', authenticateToken, (req, res) => {
    const event = db.prepare('SELECT hostId FROM gatherings WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    if (event.hostId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    db.prepare("UPDATE gatherings SET status = 'completed' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// ----------------------------------------------------
// JOIN / REQUEST FLOW
// ----------------------------------------------------

app.post('/api/gatherings/:id/join', authenticateToken, (req, res) => {
    const event = db.prepare('SELECT hostId, public, maxAttendees FROM gatherings WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Gathering not found' });

    // Check capacity
    const currentCount = db.prepare('SELECT count(*) as count FROM attendees WHERE gathering_id = ?').get(req.params.id).count;
    if (currentCount >= event.maxAttendees) {
        return res.status(400).json({ error: 'Gathering capacity reached' });
    }

    if (event.public === 1) {
        db.prepare('INSERT OR IGNORE INTO attendees (gathering_id, user_id) VALUES (?, ?)').run(req.params.id, req.user.id);
        
        // Add Host notification
        db.prepare(`
            INSERT INTO notifications (user_id, type, title, message, time)
            VALUES (?, 'new_member', 'New Guest!', ?, 'Just now')
        `).run(event.hostId, `Someone joined your public event!`);

        res.json({ status: 'joined' });
    } else {
        db.prepare('INSERT OR IGNORE INTO join_requests (gathering_id, user_id, status) VALUES (?, ?, ?)')
          .run(req.params.id, req.user.id, 'pending');

        db.prepare(`
            INSERT INTO notifications (user_id, type, title, message, time)
            VALUES (?, 'request', 'Join Request', ?, 'Just now')
        `).run(event.hostId, `A user requested an invitation to join your private event.`);

        res.json({ status: 'pending' });
    }
});

app.post('/api/gatherings/:id/leave', authenticateToken, (req, res) => {
    db.prepare('DELETE FROM attendees WHERE gathering_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    db.prepare('DELETE FROM join_requests WHERE gathering_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ success: true });
});

app.put('/api/gatherings/:id/requests', authenticateToken, (req, res) => {
    const { userId, action } = req.body; // approve or reject
    const event = db.prepare('SELECT hostId, title FROM gatherings WHERE id = ?').get(req.params.id);
    
    if (!event || event.hostId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    db.prepare('DELETE FROM join_requests WHERE gathering_id = ? AND user_id = ?').run(req.params.id, userId);

    if (action === 'approve') {
        db.prepare('INSERT OR IGNORE INTO attendees (gathering_id, user_id) VALUES (?, ?)').run(req.params.id, userId);
        
        // Notify guest
        db.prepare(`
            INSERT INTO notifications (user_id, type, title, message, time)
            VALUES (?, 'approved', 'Request Approved!', ?, 'Just now')
        `).run(userId, `Your request to join "${event.title}" has been approved!`);
    } else {
        db.prepare(`
            INSERT INTO notifications (user_id, type, title, message, time)
            VALUES (?, 'rejected', 'Request Declined', ?, 'Just now')
        `).run(userId, `Your request to join "${event.title}" was declined.`);
    }

    res.json({ success: true });
});

// Comments
app.post('/api/gatherings/:id/comments', authenticateToken, (req, res) => {
    const { text } = req.body;
    db.prepare('INSERT INTO comments (gathering_id, user_id, text) VALUES (?, ?, ?)').run(req.params.id, req.user.id, text);
    
    // Notify host if different
    const event = db.prepare('SELECT hostId, title FROM gatherings WHERE id = ?').get(req.params.id);
    if (event && event.hostId !== req.user.id) {
        db.prepare(`
            INSERT INTO notifications (user_id, type, title, message, time)
            VALUES (?, 'comment', 'New Comment', ?, 'Just now')
        `).run(event.hostId, `Someone commented on: "${event.title}"`);
    }
    
    res.json({ success: true });
});

// ----------------------------------------------------
// DASHBOARD ENDPOINTS
// ----------------------------------------------------

app.get('/api/dashboard/hosting', authenticateToken, (req, res) => {
    const events = db.prepare('SELECT * FROM gatherings WHERE hostId = ?').all(req.user.id);
    const mapped = events.map(event => {
        const attendeeIds = db.prepare('SELECT user_id FROM attendees WHERE gathering_id = ?').all(event.id).map(r => r.user_id);
        const requests = db.prepare(`
            SELECT u.id, u.name, u.avatar 
            FROM join_requests jr 
            JOIN users u ON jr.user_id = u.id 
            WHERE jr.gathering_id = ? AND jr.status = 'pending'
        `).all(event.id);
        
        return {
            ...event,
            public: event.public === 1,
            attendees: attendeeIds,
            requests
        };
    });
    res.json(mapped);
});

app.get('/api/dashboard/attending', authenticateToken, (req, res) => {
    const attending = db.prepare(`
        SELECT g.* 
        FROM attendees a 
        JOIN gatherings g ON a.gathering_id = g.id 
        WHERE a.user_id = ? AND g.hostId != ?
    `).all(req.user.id, req.user.id);

    const pending = db.prepare(`
        SELECT g.* 
        FROM join_requests jr 
        JOIN gatherings g ON jr.gathering_id = g.id 
        WHERE jr.user_id = ? AND jr.status = 'pending'
    `).all(req.user.id);

    res.json({
        attending: attending.map(g => ({ ...g, public: g.public === 1 })),
        pending: pending.map(g => ({ ...g, public: g.public === 1 }))
    });
});

// ----------------------------------------------------
// SAVED GATHERINGS
// ----------------------------------------------------

app.get('/api/saved', authenticateToken, (req, res) => {
    const list = db.prepare(`
        SELECT g.* 
        FROM saved_gatherings sg 
        JOIN gatherings g ON sg.gathering_id = g.id 
        WHERE sg.user_id = ? AND g.status = 'active'
    `).all(req.user.id);
    
    res.json(list.map(g => ({ ...g, public: g.public === 1 })));
});

app.post('/api/saved/:id', authenticateToken, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO saved_gatherings (user_id, gathering_id) VALUES (?, ?)').run(req.user.id, req.params.id);
    res.json({ success: true });
});

app.delete('/api/saved/:id', authenticateToken, (req, res) => {
    db.prepare('DELETE FROM saved_gatherings WHERE user_id = ? AND gathering_id = ?').run(req.user.id, req.params.id);
    res.json({ success: true });
});

// ----------------------------------------------------
// MESSAGES & THREADS
// ----------------------------------------------------

app.get('/api/chats', authenticateToken, (req, res) => {
    const uid = req.user.id;
    
    // Find all users current user has messages with
    const query = `
        SELECT DISTINCT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as chatter_id 
        FROM messages 
        WHERE sender_id = ? OR receiver_id = ?
    `;
    const chatters = db.prepare(query).all(uid, uid, uid).map(r => r.chatter_id);

    const threads = chatters.map(chatterId => {
        const oppUser = db.prepare('SELECT id, name, username, avatar FROM users WHERE id = ?').get(chatterId);
        
        // Find last message
        const lastMsg = db.prepare(`
            SELECT text, timestamp, sender_id 
            FROM messages 
            WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
            ORDER BY id DESC LIMIT 1
        `).get(uid, chatterId, chatterId, uid);

        return {
            id: `chat_${uid}_${chatterId}`,
            userA: uid,
            userB: chatterId,
            oppUser,
            lastMsg
        };
    });

    res.json(threads);
});

app.get('/api/chats/:userId', authenticateToken, (req, res) => {
    const opposingId = req.params.userId;
    const uid = req.user.id;
    
    // Mark as read
    db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?').run(opposingId, uid);

    const msgs = db.prepare(`
        SELECT * FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
        ORDER BY id ASC
    `).all(uid, opposingId, opposingId, uid);

    res.json(msgs);
});

// ----------------------------------------------------
// NOTIFICATIONS
// ----------------------------------------------------

app.get('/api/notifications', authenticateToken, (req, res) => {
    const list = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json(list.map(n => ({ ...n, read: n.read === 1 })));
});

app.put('/api/notifications/read', authenticateToken, (req, res) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    res.json({ success: true });
});

// ----------------------------------------------------
// SAFETY & BLOCKS
// ----------------------------------------------------

app.post('/api/safety/block', authenticateToken, (req, res) => {
    const { targetUserId } = req.body;
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, targetUserId);
    res.json({ success: true });
});

app.post('/api/safety/report', authenticateToken, (req, res) => {
    const { reportedType, reportedId, reason, details } = req.body;
    db.prepare('INSERT INTO reports (reporter_id, reported_type, reported_id, reason, details) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, reportedType, reportedId, reason, details);
    res.json({ success: true });
});

// ----------------------------------------------------
// SOCKET.IO REALTIME EVENTS
// ----------------------------------------------------

const activeSockets = new Map(); // Maps user.id -> socket.id

io.on('connection', (socket) => {
    
    socket.on('register_user', (userId) => {
        activeSockets.set(userId, socket.id);
        socket.userId = userId;
    });

    socket.on('send_chat', (data) => {
        const { receiverId, text, imageUrl } = data;
        const senderId = socket.userId;
        if (!senderId) return;

        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        // Save to DB
        const result = db.prepare(`
            INSERT INTO messages (sender_id, receiver_id, text, image_url, timestamp, is_read)
            VALUES (?, ?, ?, ?, ?, 0)
        `).run(senderId, receiverId, text, imageUrl || null, timestamp);

        const savedMsg = {
            id: result.lastInsertRowid,
            sender_id: senderId,
            receiver_id: receiverId,
            text,
            image_url: imageUrl || null,
            timestamp,
            is_read: 0
        };

        // Emit back to sender
        socket.emit('receive_chat', savedMsg);

        // Send to receiver if online
        const receiverSocketId = activeSockets.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('receive_chat', savedMsg);
        }
        
        // Generate automatic mock response trigger if receiver is a simulated host account
        if (receiverId.startsWith('host_') || receiverId.startsWith('guest_')) {
            setTimeout(() => {
                const typingSocketId = activeSockets.get(senderId);
                if (typingSocketId) {
                    io.to(typingSocketId).emit('opp_typing', { typing: true });
                }
                
                setTimeout(() => {
                    if (typingSocketId) {
                        io.to(typingSocketId).emit('opp_typing', { typing: false });
                    }
                    
                    let replyText = `Hey! Thanks for messaging. Let me check the details and get right back to you!`;
                    if (text.toLowerCase().includes('wine')) {
                        replyText = `Red wine pairs beautifully with the fresh tomato pasta I'm preparing. Thanks for bringing a bottle!`;
                    }
                    
                    const replyTimestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const replyResult = db.prepare(`
                        INSERT INTO messages (sender_id, receiver_id, text, timestamp, is_read)
                        VALUES (?, ?, ?, ?, 1)
                    `).run(receiverId, senderId, replyText, replyTimestamp);
                    
                    const replyMsg = {
                        id: replyResult.lastInsertRowid,
                        sender_id: receiverId,
                        receiver_id: senderId,
                        text: replyText,
                        image_url: null,
                        timestamp: replyTimestamp,
                        is_read: 1
                    };
                    
                    socket.emit('receive_chat', replyMsg);
                }, 2000);
            }, 1000);
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            activeSockets.delete(socket.userId);
        }
    });
});

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Melo scalable backend listening on port ${PORT}`);
});
