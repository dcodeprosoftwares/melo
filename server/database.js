import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

// Load DB connection string from env
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error("CRITICAL ERROR: DATABASE_URL environment variable is missing!");
}

export const pool = new Pool({
    connectionString,
    ssl: connectionString && !connectionString.includes('localhost') ? {
        rejectUnauthorized: false // Required for hosted databases (Supabase/Neon)
    } : false
});

export async function query(text, params) {
    return pool.query(text, params);
}

export async function initDatabase() {
    if (!connectionString) return;

    // 1. Create Users Table
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            phone VARCHAR(50),
            email VARCHAR(255),
            password_hash VARCHAR(255),
            name VARCHAR(255) NOT NULL,
            username VARCHAR(255) UNIQUE NOT NULL,
            avatar TEXT,
            bio TEXT,
            interests TEXT, -- JSON Array
            languages TEXT, -- JSON Array
            city VARCHAR(255),
            dob VARCHAR(50),
            gender VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 2. Create Gatherings Table
    await query(`
        CREATE TABLE IF NOT EXISTS gatherings (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT NOT NULL,
            category VARCHAR(255) NOT NULL,
            date VARCHAR(50) NOT NULL,
            time VARCHAR(50) NOT NULL,
            "endTime" VARCHAR(50),
            venue VARCHAR(255) NOT NULL,
            location VARCHAR(255) NOT NULL,
            "maxAttendees" INTEGER NOT NULL,
            public INTEGER DEFAULT 1,
            "ageRestriction" VARCHAR(255),
            "dressCode" VARCHAR(255),
            "itemsToBring" TEXT,
            rules TEXT,
            "coverImage" TEXT,
            tags TEXT, -- JSON Array
            lat DECIMAL,
            lng DECIMAL,
            status VARCHAR(50) DEFAULT 'active',
            "hostId" VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY("hostId") REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 3. Create Attendees Table
    await query(`
        CREATE TABLE IF NOT EXISTS attendees (
            gathering_id INTEGER,
            user_id VARCHAR(255),
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (gathering_id, user_id),
            FOREIGN KEY(gathering_id) REFERENCES gatherings(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 4. Create Join Requests Table
    await query(`
        CREATE TABLE IF NOT EXISTS join_requests (
            gathering_id INTEGER,
            user_id VARCHAR(255),
            status VARCHAR(50) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (gathering_id, user_id),
            FOREIGN KEY(gathering_id) REFERENCES gatherings(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 5. Create Messages Table
    await query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            sender_id VARCHAR(255) NOT NULL,
            receiver_id VARCHAR(255) NOT NULL,
            text TEXT NOT NULL,
            image_url TEXT,
            timestamp VARCHAR(50) NOT NULL,
            is_read INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(receiver_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 6. Create Comments Table
    await query(`
        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            gathering_id INTEGER NOT NULL,
            user_id VARCHAR(255) NOT NULL,
            text TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(gathering_id) REFERENCES gatherings(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 7. Create Notifications Table
    await query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            type VARCHAR(50) NOT NULL,
            title VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            read INTEGER DEFAULT 0,
            time VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 8. Create Saved Gatherings
    await query(`
        CREATE TABLE IF NOT EXISTS saved_gatherings (
            user_id VARCHAR(255),
            gathering_id INTEGER,
            PRIMARY KEY (user_id, gathering_id),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(gathering_id) REFERENCES gatherings(id) ON DELETE CASCADE
        )
    `);

    // Migration: Add lat and lng to gatherings if they don't exist
    try {
        await query(`ALTER TABLE gatherings ADD COLUMN lat DECIMAL`);
    } catch(e) { /* Ignore if exists */ }
    try {
        await query(`ALTER TABLE gatherings ADD COLUMN lng DECIMAL`);
    } catch(e) { /* Ignore if exists */ }

    // Dummy Data Checks Table
    await query(`
        CREATE TABLE IF NOT EXISTS blocks (
            blocker_id VARCHAR(255),
            blocked_id VARCHAR(255),
            PRIMARY KEY (blocker_id, blocked_id),
            FOREIGN KEY(blocker_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(blocked_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // 10. Create Reports Table
    await query(`
        CREATE TABLE IF NOT EXISTS reports (
            id SERIAL PRIMARY KEY,
            reporter_id VARCHAR(255),
            reported_type VARCHAR(50),
            reported_id VARCHAR(255),
            reason VARCHAR(255),
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create Indexes
    await query(`CREATE INDEX IF NOT EXISTS idx_gatherings_host ON gatherings("hostId")`);
    await query(`CREATE INDEX IF NOT EXISTS idx_gatherings_status ON gatherings(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver ON messages(sender_id, receiver_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_comments_gathering ON comments(gathering_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)`);

    // Seed Data
    await seedDatabase();
}

async function seedDatabase() {
    const userRes = await query('SELECT count(*) as count FROM users');
    const userCount = parseInt(userRes.rows[0].count);
    if (userCount > 0) return;

    console.log('Seeding initial database tables on PostgreSQL...');

    const passHash = bcrypt.hashSync('melo1234', 10);

    const initialUsers = [
        {
            id: 'host_john',
            phone: '+15551234567',
            email: 'john@melo.com',
            name: 'John Doe',
            username: 'johndoe',
            avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop',
            bio: "Host extraordinaire! Passionate about culinary arts, local history, and board games. Let's make new memories.",
            interests: JSON.stringify(["Dinner", "Movie Night", "Book Club", "Wine Tasting"]),
            languages: JSON.stringify(["English", "Spanish"]),
            city: 'San Francisco',
            dob: '1994-05-12',
            gender: 'Male'
        },
        {
            id: 'host_sarah',
            phone: '+15559876543',
            email: 'sarah@melo.com',
            name: 'Sarah Chen',
            username: 'sarahc',
            avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop',
            bio: "Product designer and outdoor enthusiast. Let's grab coffee or go for trail runs around the Bay.",
            interests: JSON.stringify(["Coffee Meetup", "Startup Networking", "Hiking", "Cycling"]),
            languages: JSON.stringify(["English", "Mandarin"]),
            city: 'San Francisco',
            dob: '1997-09-21',
            gender: 'Female'
        },
        {
            id: 'guest_carlos',
            phone: '+15554567890',
            email: 'carlos@melo.com',
            name: 'Carlos Ruiz',
            username: 'carlosr',
            avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop',
            bio: "Software developer. Always down for house parties, video games, and exploring local parks.",
            interests: JSON.stringify(["Gaming", "House Party", "Sports", "Hiking"]),
            languages: JSON.stringify(["Spanish", "English"]),
            city: 'San Francisco',
            dob: '1995-11-04',
            gender: 'Male'
        },
        {
            id: 'guest_emily',
            phone: '+15550192834',
            email: 'emily@melo.com',
            name: 'Emily Smith',
            username: 'emily_s',
            avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&auto=format&fit=crop',
            bio: "Freelance photographer. Love hiking, art gallery openings, and book discussion groups.",
            interests: JSON.stringify(["Photography", "Book Club", "Hiking", "Cultural"]),
            languages: JSON.stringify(["English", "French"]),
            city: 'Oakland',
            dob: '1998-02-18',
            gender: 'Female'
        }
    ];

    for (const u of initialUsers) {
        await query(`
            INSERT INTO users (id, phone, email, password_hash, name, username, avatar, bio, interests, languages, city, dob, gender)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [u.id, u.phone, u.email, passHash, u.name, u.username, u.avatar, u.bio, u.interests, u.languages, u.city, u.dob, u.gender]);
    }

    const initialGatherings = [
        {
            title: "Cozy Sunset Wine & Pasta Night",
            description: "Let's gather for an informal home-cooked dinner, good wine, and chatting about life. I will prepare fresh handmade fettuccine. Bring your favorite dessert or a bottle of wine to share!",
            category: "Dinner",
            date: "2026-08-12",
            time: "18:30",
            endTime: "22:00",
            venue: "John's Penthouse, Downtown",
            location: "San Francisco, CA",
            maxAttendees: 8,
            public: 0, // private
            ageRestriction: "Age 21+",
            dressCode: "Smart Casual",
            itemsToBring: "Bottle of wine or artisanal dessert",
            coverImage: "https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=800&auto=format&fit=crop",
            rules: "Take off shoes at the door. Respect neighbors during departure. Positive vibes only!",
            tags: JSON.stringify(["Wine", "Pasta", "Intimate", "Social"]),
            hostId: "host_john",
            status: "active"
        },
        {
            title: "Morning Coffee & Startup Networking",
            description: "Looking to connect with developers, designers, and startup founders. Let's grab coffee, share what we are building, and get some deep work or brainstorming done. Coffee is on me!",
            category: "Coffee Meetup",
            date: "2026-08-15",
            time: "09:00",
            endTime: "12:00",
            venue: "The Grind Café, SOMA",
            location: "San Francisco, CA",
            maxAttendees: 15,
            public: 1, // public
            ageRestriction: "All ages",
            dressCode: "Casual",
            itemsToBring: "Laptop, notebook, and creative concepts",
            coverImage: "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=800&auto=format&fit=crop",
            rules: "Support the local café, keep tech discussions collaborative and supportive.",
            tags: JSON.stringify(["Tech", "Business", "Co-working", "Networking"]),
            hostId: "host_sarah",
            status: "active"
        },
        {
            title: "Marin Headlands Loop Hike & Picnic",
            description: "A scenic 6-mile moderate loop trail with stunning lookouts over the Golden Gate Bridge and the Pacific Ocean. We will stop for a group picnic lunch at the peak. Bring dogs if friendly!",
            category: "Hiking",
            date: "2026-08-16",
            time: "08:30",
            endTime: "13:30",
            venue: "Marin Headlands Trailhead parking lot",
            location: "Sausalito, CA",
            maxAttendees: 20,
            public: 1,
            ageRestriction: "All ages",
            dressCode: "Athletic / Hiking gear",
            itemsToBring: "2L water, packed picnic lunch, sunscreen",
            coverImage: "https://images.unsplash.com/photo-1551632879-25b2d2a01a18?w=800&auto=format&fit=crop",
            rules: "Leave no trace. Stay on designated paths.",
            tags: JSON.stringify(["Nature", "Hike", "Dog-friendly", "Fitness"]),
            hostId: "host_sarah",
            status: "active"
        },
        {
            title: "Retro Console Board Games & Pizza Night",
            description: "N64, Mario Kart, Smash Bros, Settlers of Catan, and hot fresh woodfired pizza. Welcoming all skill levels for a fun Friday night social gaming session. Let's see who is the champion!",
            category: "Gaming",
            date: "2026-08-11",
            time: "19:00",
            endTime: "23:00",
            venue: "Carlos's Social Den, Mission District",
            location: "San Francisco, CA",
            maxAttendees: 10,
            public: 1,
            ageRestriction: "Age 18+",
            dressCode: "Casual",
            itemsToBring: "Your favorite retro controller or gaming snack",
            coverImage: "https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=800&auto=format&fit=crop",
            rules: "No rage quitting. Keep competitive energy friendly and fun.",
            tags: JSON.stringify(["Retro", "Board Games", "Pizza", "Friday Night"]),
            hostId: "guest_carlos",
            status: "active"
        }
    ];

    for (const g of initialGatherings) {
        await query(`
            INSERT INTO gatherings (title, description, category, date, time, "endTime", venue, location, "maxAttendees", public, "ageRestriction", "dressCode", "itemsToBring", rules, "coverImage", tags, "hostId", status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        `, [g.title, g.description, g.category, g.date, g.time, g.endTime, g.venue, g.location, g.maxAttendees, g.public, g.ageRestriction, g.dressCode, g.itemsToBring, g.rules, g.coverImage, g.tags, g.hostId, g.status]);
    }

    // Seed Attendees
    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (1, 'host_john')");
    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (1, 'guest_carlos')");

    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (2, 'host_sarah')");
    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (2, 'guest_emily')");

    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (3, 'host_sarah')");
    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (3, 'host_john')");
    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (3, 'guest_emily')");

    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (4, 'guest_carlos')");
    await query("INSERT INTO attendees (gathering_id, user_id) VALUES (4, 'host_john')");

    // Seed Messages
    const initialMessages = [
        { sender: "guest_carlos", receiver: "host_john", text: "Hey John, excited for the pasta night! Should I bring red or white wine?", timestamp: "18:04" },
        { sender: "host_john", receiver: "guest_carlos", text: "Hey Carlos! Red goes beautifully with the fresh tomato fettuccine sauce I'm making.", timestamp: "18:15" },
        { sender: "guest_carlos", receiver: "host_john", text: "Got it! I will pick up a nice Pinot Noir.", timestamp: "18:20" }
    ];

    for (const m of initialMessages) {
        await query(`
            INSERT INTO messages (sender_id, receiver_id, text, timestamp, is_read)
            VALUES ($1, $2, $3, $4, 1)
        `, [m.sender, m.receiver, m.text, m.timestamp]);
    }

    // Seed Comments
    await query(`
        INSERT INTO comments (gathering_id, user_id, text)
        VALUES (1, 'guest_carlos', 'Can''t wait for this! John''s home-cooked pasta is legendary.')
    `);

    // Seed Notifications
    await query(`
        INSERT INTO notifications (user_id, type, title, message, read, time)
        VALUES ('guest_emily', 'reminder', 'Upcoming Event', 'Retro Console Board Games & Pizza starts tomorrow at 19:00!', 0, '1 hour ago')
    `);

    console.log('PostgreSQL database seeded successfully!');
}
