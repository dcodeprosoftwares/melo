import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, initDatabase } from './database.js';

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'melo_secret_token_key_2026';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../dist');

// Initialize database tables
initDatabase().catch(err => {
    console.error("Database initialization failed:", err);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
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

app.post('/api/auth/login-register', async (req, res) => {
    const { phone, email, password } = req.body;
    let user = null;

    try {
        if (phone) {
            const userRes = await query('SELECT * FROM users WHERE phone = $1', [phone]);
            user = userRes.rows[0];
            if (!user) {
                const newId = 'user_' + Date.now();
                const username = 'user_' + Math.floor(1000 + Math.random() * 9000);
                await query(`
                    INSERT INTO users (id, phone, name, username, interests, languages) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [newId, phone, 'Guest User', username, '[]', '[]']);
                
                const selectRes = await query('SELECT * FROM users WHERE id = $1', [newId]);
                user = selectRes.rows[0];
            }
        } else if (email) {
            const userRes = await query('SELECT * FROM users WHERE email = $1', [email]);
            user = userRes.rows[0];
            if (!user) {
                const newId = 'user_' + Date.now();
                const username = email.split('@')[0] + Math.floor(100 + Math.random() * 900);
                const passHash = bcrypt.hashSync(password || 'melo1234', 10);
                await query(`
                    INSERT INTO users (id, email, password_hash, name, username, interests, languages) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [newId, email, passHash, email.split('@')[0], username, '[]', '[]']);
                
                const selectRes = await query('SELECT * FROM users WHERE id = $1', [newId]);
                user = selectRes.rows[0];
            } else if (password) {
                if (user.password_hash && !bcrypt.compareSync(password, user.password_hash)) {
                    return res.status(400).json({ error: 'Invalid credentials.' });
                }
            }
        } else {
            return res.status(400).json({ error: 'Auth credentials required.' });
        }

        user.interests = JSON.parse(user.interests || '[]');
        user.languages = JSON.parse(user.languages || '[]');

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/profile', authenticateToken, async (req, res) => {
    const { name, username, avatar, bio, interests, languages, city, dob, gender } = req.body;
    
    try {
        await query(`
            UPDATE users 
            SET name = $1, username = $2, avatar = $3, bio = $4, interests = $5, languages = $6, city = $7, dob = $8, gender = $9
            WHERE id = $10
        `, [
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
        ]);
        
        const selectRes = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        const updatedUser = selectRes.rows[0];
        updatedUser.interests = JSON.parse(updatedUser.interests || '[]');
        updatedUser.languages = JSON.parse(updatedUser.languages || '[]');
        
        res.json({ success: true, user: updatedUser });
    } catch (err) {
        if (err.message.includes('unique') || err.message.includes('duplicate')) {
            return res.status(400).json({ error: 'Username already taken.' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const selectRes = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        const user = selectRes.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        user.interests = JSON.parse(user.interests || '[]');
        user.languages = JSON.parse(user.languages || '[]');
        res.json(user);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/:username', authenticateToken, async (req, res) => {
    try {
        const selectRes = await query('SELECT id, name, username, avatar, bio, interests, languages, city FROM users WHERE username = $1', [req.params.username]);
        const user = selectRes.rows[0];
        if (!user) return res.status(404).json({ error: 'Profile not found' });
        
        user.interests = JSON.parse(user.interests || '[]');
        user.languages = JSON.parse(user.languages || '[]');
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// GATHERINGS ENDPOINTS
// ----------------------------------------------------

app.get('/api/gatherings', authenticateToken, async (req, res) => {
    const { search, category, date, public: isPub, age18, smallGroup } = req.query;
    
    try {
        const blockedRecords = (await query('SELECT blocked_id FROM blocks WHERE blocker_id = $1', [req.user.id])).rows;
        const blockedByUser = blockedRecords.map(r => r.blocked_id);
        
        const blockersRecords = (await query('SELECT blocker_id FROM blocks WHERE blocked_id = $1', [req.user.id])).rows;
        const blockersOfUser = blockersRecords.map(r => r.blocker_id);
        const excludedHosts = [...blockedByUser, ...blockersOfUser];

        let queryStr = 'SELECT * FROM gatherings WHERE status = $1';
        let params = ['active'];

        if (excludedHosts.length > 0) {
            const placeholders = excludedHosts.map((_, idx) => `$${idx + 2}`).join(',');
            queryStr += ` AND "hostId" NOT IN (${placeholders})`;
            params.push(...excludedHosts);
        }

        const queryRes = await query(queryStr, params);
        let results = queryRes.rows;

        // In-memory filters (Text Searches)
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

        // Attach host profile details & guest rosters count
        const mapped = [];
        for (const g of results) {
            const host = (await query('SELECT id, name, username, avatar FROM users WHERE id = $1', [g.hostId])).rows[0];
            const attendeesCount = parseInt((await query('SELECT count(*) as count FROM attendees WHERE gathering_id = $1', [g.id])).rows[0].count);
            const attendeesList = (await query('SELECT user_id FROM attendees WHERE gathering_id = $1', [g.id])).rows.map(r => r.user_id);
            const requestsList = (await query('SELECT user_id FROM join_requests WHERE gathering_id = $1 AND status = $2', [g.id, 'pending'])).rows.map(r => r.user_id);
            
            mapped.push({
                ...g,
                public: g.public === 1,
                tags: JSON.parse(g.tags || '[]'),
                host,
                attendeeCount: attendeesCount,
                attendees: attendeesList,
                requests: requestsList,
                distance: "1.2 miles away"
            });
        }

        res.json(mapped);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gatherings', authenticateToken, async (req, res) => {
    const { title, description, category, date, time, endTime, venue, location, maxAttendees, public: isPub, ageRestriction, dressCode, itemsToBring, rules, coverImage, tags } = req.body;
    
    try {
        const result = await query(`
            INSERT INTO gatherings (title, description, category, date, time, "endTime", venue, location, "maxAttendees", public, "ageRestriction", "dressCode", "itemsToBring", rules, "coverImage", tags, "hostId")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING id
        `, [
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
        ]);

        const newId = result.rows[0].id;
        await query('INSERT INTO attendees (gathering_id, user_id) VALUES ($1, $2)', [newId, req.user.id]);

        res.json({ success: true, id: newId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/gatherings/:id', authenticateToken, async (req, res) => {
    try {
        const selectRes = await query('SELECT * FROM gatherings WHERE id = $1', [req.params.id]);
        const event = selectRes.rows[0];
        if (!event) return res.status(404).json({ error: 'Gathering not found' });

        event.public = event.public === 1;
        event.tags = JSON.parse(event.tags || '[]');
        
        const host = (await query('SELECT id, name, username, avatar, bio FROM users WHERE id = $1', [event.hostId])).rows[0];
        
        const attendeeRecords = (await query(`
            SELECT u.id, u.name, u.username, u.avatar 
            FROM attendees a 
            JOIN users u ON a.user_id = u.id 
            WHERE a.gathering_id = $1
        `, [event.id])).rows;

        const requestRecords = (await query('SELECT user_id FROM join_requests WHERE gathering_id = $1 AND status = $2', [event.id, 'pending'])).rows.map(r => r.user_id);

        const commentRecords = (await query(`
            SELECT c.text, c.created_at, u.name as "userName", u.avatar as "userAvatar" 
            FROM comments c 
            JOIN users u ON c.user_id = u.id 
            WHERE c.gathering_id = $1 
            ORDER BY c.id ASC
        `, [event.id])).rows;
        
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/gatherings/:id', authenticateToken, async (req, res) => {
    try {
        const event = (await query('SELECT "hostId" FROM gatherings WHERE id = $1', [req.params.id])).rows[0];
        if (!event) return res.status(404).json({ error: 'Not found' });
        if (event.hostId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

        await query('DELETE FROM gatherings WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gatherings/:id/complete', authenticateToken, async (req, res) => {
    try {
        const event = (await query('SELECT "hostId" FROM gatherings WHERE id = $1', [req.params.id])).rows[0];
        if (!event) return res.status(404).json({ error: 'Not found' });
        if (event.hostId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

        await query("UPDATE gatherings SET status = 'completed' WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// JOIN / REQUEST FLOW
// ----------------------------------------------------

app.post('/api/gatherings/:id/join', authenticateToken, async (req, res) => {
    try {
        const event = (await query('SELECT "hostId", public, "maxAttendees" FROM gatherings WHERE id = $1', [req.params.id])).rows[0];
        if (!event) return res.status(404).json({ error: 'Gathering not found' });

        const currentCount = parseInt((await query('SELECT count(*) as count FROM attendees WHERE gathering_id = $1', [req.params.id])).rows[0].count);
        if (currentCount >= event.maxAttendees) {
            return res.status(400).json({ error: 'Gathering capacity reached' });
        }

        if (event.public === 1) {
            await query('INSERT INTO attendees (gathering_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
            
            await query(`
                INSERT INTO notifications (user_id, type, title, message, time)
                VALUES ($1, 'new_member', 'New Guest!', $2, 'Just now')
            `, [event.hostId, `Someone joined your public event!`]);

            res.json({ status: 'joined' });
        } else {
            await query('INSERT INTO join_requests (gathering_id, user_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.params.id, req.user.id, 'pending']);

            await query(`
                INSERT INTO notifications (user_id, type, title, message, time)
                VALUES ($1, 'request', 'Join Request', $2, 'Just now')
            `, [event.hostId, `A user requested an invitation to join your private event.`]);

            res.json({ status: 'pending' });
        }
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gatherings/:id/leave', authenticateToken, async (req, res) => {
    try {
        await query('DELETE FROM attendees WHERE gathering_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        await query('DELETE FROM join_requests WHERE gathering_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/gatherings/:id/requests', authenticateToken, async (req, res) => {
    const { userId, action } = req.body;
    
    try {
        const event = (await query('SELECT "hostId", title FROM gatherings WHERE id = $1', [req.params.id])).rows[0];
        
        if (!event || event.hostId !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await query('DELETE FROM join_requests WHERE gathering_id = $1 AND user_id = $2', [req.params.id, userId]);

        if (action === 'approve') {
            await query('INSERT INTO attendees (gathering_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, userId]);
            
            await query(`
                INSERT INTO notifications (user_id, type, title, message, time)
                VALUES ($1, 'approved', 'Request Approved!', $2, 'Just now')
            `, [userId, `Your request to join "${event.title}" has been approved!`]);
        } else {
            await query(`
                INSERT INTO notifications (user_id, type, title, message, time)
                VALUES ($1, 'rejected', 'Request Declined', $2, 'Just now')
            `, [userId, `Your request to join "${event.title}" was declined.`]);
        }

        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gatherings/:id/comments', authenticateToken, async (req, res) => {
    const { text } = req.body;
    try {
        await query('INSERT INTO comments (gathering_id, user_id, text) VALUES ($1, $2, $3)', [req.params.id, req.user.id, text]);
        
        const event = (await query('SELECT "hostId", title FROM gatherings WHERE id = $1', [req.params.id])).rows[0];
        if (event && event.hostId !== req.user.id) {
            await query(`
                INSERT INTO notifications (user_id, type, title, message, time)
                VALUES ($1, 'comment', 'New Comment', $2, 'Just now')
            `, [event.hostId, `Someone commented on: "${event.title}"`]);
        }
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// DASHBOARD ENDPOINTS
// ----------------------------------------------------

app.get('/api/dashboard/hosting', authenticateToken, async (req, res) => {
    try {
        const events = (await query('SELECT * FROM gatherings WHERE "hostId" = $1', [req.user.id])).rows;
        const mapped = [];
        for (const event of events) {
            const attendeeIds = (await query('SELECT user_id FROM attendees WHERE gathering_id = $1', [event.id])).rows.map(r => r.user_id);
            const requests = (await query(`
                SELECT u.id, u.name, u.avatar 
                FROM join_requests jr 
                JOIN users u ON jr.user_id = u.id 
                WHERE jr.gathering_id = $1 AND jr.status = 'pending'
            `, [event.id])).rows;
            
            mapped.push({
                ...event,
                public: event.public === 1,
                attendees: attendeeIds,
                requests
            });
        }
        res.json(mapped);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/attending', authenticateToken, async (req, res) => {
    try {
        const attending = (await query(`
            SELECT g.* 
            FROM attendees a 
            JOIN gatherings g ON a.gathering_id = g.id 
            WHERE a.user_id = $1 AND g."hostId" != $2
        `, [req.user.id, req.user.id])).rows;

        const pending = (await query(`
            SELECT g.* 
            FROM join_requests jr 
            JOIN gatherings g ON jr.gathering_id = g.id 
            WHERE jr.user_id = $1 AND jr.status = 'pending'
        `, [req.user.id])).rows;

        res.json({
            attending: attending.map(g => ({ ...g, public: g.public === 1 })),
            pending: pending.map(g => ({ ...g, public: g.public === 1 }))
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// SAVED GATHERINGS
// ----------------------------------------------------

app.get('/api/saved', authenticateToken, async (req, res) => {
    try {
        const list = (await query(`
            SELECT g.* 
            FROM saved_gatherings sg 
            JOIN gatherings g ON sg.gathering_id = g.id 
            WHERE sg.user_id = $1 AND g.status = 'active'
        `, [req.user.id])).rows;
        
        res.json(list.map(g => ({ ...g, public: g.public === 1 })));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/saved/:id', authenticateToken, async (req, res) => {
    try {
        await query('INSERT INTO saved_gatherings (user_id, gathering_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/saved/:id', authenticateToken, async (req, res) => {
    try {
        await query('DELETE FROM saved_gatherings WHERE user_id = $1 AND gathering_id = $2', [req.user.id, req.params.id]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// MESSAGES & THREADS
// ----------------------------------------------------

app.get('/api/chats', authenticateToken, async (req, res) => {
    const uid = req.user.id;
    
    try {
        const queryStr = `
            SELECT DISTINCT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END as chatter_id 
            FROM messages 
            WHERE sender_id = $2 OR receiver_id = $3
        `;
        const chatters = (await query(queryStr, [uid, uid, uid])).rows.map(r => r.chatter_id);

        const threads = [];
        for (const chatterId of chatters) {
            const oppUser = (await query('SELECT id, name, username, avatar FROM users WHERE id = $1', [chatterId])).rows[0];
            
            const lastMsg = (await query(`
                SELECT text, timestamp, sender_id 
                FROM messages 
                WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $3 AND receiver_id = $4)
                ORDER BY id DESC LIMIT 1
            `, [uid, chatterId, chatterId, uid])).rows[0] || null;

            threads.push({
                id: `chat_${uid}_${chatterId}`,
                userA: uid,
                userB: chatterId,
                oppUser,
                lastMsg
            });
        }

        res.json(threads);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chats/:userId', authenticateToken, async (req, res) => {
    const opposingId = req.params.userId;
    const uid = req.user.id;
    
    try {
        await query('UPDATE messages SET is_read = 1 WHERE sender_id = $1 AND receiver_id = $2', [opposingId, uid]);

        const msgs = (await query(`
            SELECT * FROM messages 
            WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $3 AND receiver_id = $4)
            ORDER BY id ASC
        `, [uid, opposingId, opposingId, uid])).rows;

        res.json(msgs);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// NOTIFICATIONS
// ----------------------------------------------------

app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const list = (await query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC', [req.user.id])).rows;
        res.json(list.map(n => ({ ...n, read: n.read === 1 })));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/read', authenticateToken, async (req, res) => {
    try {
        await query('UPDATE notifications SET read = 1 WHERE user_id = $1', [req.user.id]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// SAFETY & BLOCKS
// ----------------------------------------------------

app.post('/api/safety/block', authenticateToken, async (req, res) => {
    const { targetUserId } = req.body;
    try {
        await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, targetUserId]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/safety/report', authenticateToken, async (req, res) => {
    const { reportedType, reportedId, reason, details } = req.body;
    try {
        await query('INSERT INTO reports (reporter_id, reported_type, reported_id, reason, details) VALUES ($1, $2, $3, $4, $5)', [req.user.id, reportedType, reportedId, reason, details]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------
// SOCKET.IO REALTIME EVENTS
// ----------------------------------------------------

const activeSockets = new Map();

io.on('connection', (socket) => {
    
    socket.on('register_user', (userId) => {
        activeSockets.set(userId, socket.id);
        socket.userId = userId;
    });

    socket.on('send_chat', async (data) => {
        const { receiverId, text, imageUrl } = data;
        const senderId = socket.userId;
        if (!senderId) return;

        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        try {
            // Save to DB
            const result = await query(`
                INSERT INTO messages (sender_id, receiver_id, text, image_url, timestamp, is_read)
                VALUES ($1, $2, $3, $4, $5, 0)
                RETURNING id
            `, [senderId, receiverId, text, imageUrl || null, timestamp]);

            const savedMsg = {
                id: result.rows[0].id,
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
            
            // Mock auto-responder logic for host users
            if (receiverId.startsWith('host_') || receiverId.startsWith('guest_')) {
                setTimeout(() => {
                    const typingSocketId = activeSockets.get(senderId);
                    if (typingSocketId) {
                        io.to(typingSocketId).emit('opp_typing', { typing: true });
                    }
                    
                    setTimeout(async () => {
                        if (typingSocketId) {
                            io.to(typingSocketId).emit('opp_typing', { typing: false });
                        }
                        
                        let replyText = `Hey! Thanks for messaging. Let me check the details and get right back to you!`;
                        if (text.toLowerCase().includes('wine')) {
                            replyText = `Red wine pairs beautifully with the fresh tomato pasta I'm preparing. Thanks for bringing a bottle!`;
                        }
                        
                        const replyTimestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        const replyResult = await query(`
                            INSERT INTO messages (sender_id, receiver_id, text, timestamp, is_read)
                            VALUES ($1, $2, $3, $4, 1)
                            RETURNING id
                        `, [receiverId, senderId, replyText, replyTimestamp]);
                        
                        const replyMsg = {
                            id: replyResult.rows[0].id,
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
        } catch(err) {
            console.error("Socket chat persist error:", err);
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            activeSockets.delete(socket.userId);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Melo scalable backend listening on port ${PORT}`);
});
