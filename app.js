// Melo Application Engine - Frontend API Integration & WebSocket Connection

const IS_DEV = window.location.port === '5174';
const API_BASE = IS_DEV ? 'http://localhost:3000/api' : '/api';
const SOCKET_URL = IS_DEV ? 'http://localhost:3000' : window.location.origin;
let socket = null;
let token = localStorage.getItem("melo_jwt_token") || null;

// Global State (Cached views metadata)
let state = {
    currentUser: null,
    gatherings: [],
    chats: [],
    notifications: [],
    savedGatherings: [],
    recentSearches: ["Wine", "Hike", "SOMA"],
    trendingSearches: ["Pasta Night", "Networking", "Cycling", "Coffee"],
    darkMode: localStorage.getItem("melo_dark_mode") === "true",
    currentExploreFilter: "all",
    searchQuery: ""
};

// Unified fetch wrapper with Authorization support
async function apiFetch(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const config = {
        ...options,
        headers
    };

    try {
        const response = await fetch(url, config);
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Server error occurred');
        }
        return data;
    } catch (err) {
        showPopMessage(err.message, 'danger');
        throw err;
    }
}

// Initialize Application
async function initApp() {
    // Theme setup
    if (state.darkMode) {
        document.body.classList.add("dark-mode");
    } else {
        document.body.classList.remove("dark-mode");
    }

    // Check Routing
    window.addEventListener("hashchange", handleRouting);

    if (token) {
        try {
            // Load user data on startup
            const user = await apiFetch('/auth/me');
            state.currentUser = user;
            initWebSockets();
            refreshBellNotificationCount();
            
            // Redirect to home if on auth screen
            if (!window.location.hash || window.location.hash === "#auth") {
                window.location.hash = "#home";
            }
        } catch (err) {
            // Token is invalid, wipe session
            handleLogoutSilent();
        }
    } else {
        window.location.hash = "#auth";
    }

    handleRouting();
}

// Setup real-time WebSockets with Socket.io-client
function initWebSockets() {
    if (!state.currentUser) return;
    
    // Disconnect old socket if open
    if (socket) {
        socket.disconnect();
    }

    socket = io(SOCKET_URL);

    socket.on('connect', () => {
        socket.emit('register_user', state.currentUser.id);
    });

    socket.on('receive_chat', (msg) => {
        // Play notification pop
        const sound = document.getElementById("sound-pop");
        if (sound) {
            sound.muted = false;
            sound.play().catch(() => {});
        }

        // If chat window is open and conversation matches, append message dynamically
        const hash = window.location.hash;
        if (hash.startsWith('#chat')) {
            const opposingId = msg.sender_id === state.currentUser.id ? msg.receiver_id : msg.sender_id;
            
            // Re-render chat area
            const scroller = document.getElementById("chat-messages-scroll");
            if (scroller) {
                const bubble = document.createElement("div");
                const isSent = msg.sender_id === state.currentUser.id;
                bubble.className = `chat-bubble-wrapper ${isSent ? 'sent' : 'received'}`;
                bubble.innerHTML = `
                    <div class="chat-bubble">${msg.text}</div>
                    <span class="chat-bubble-time">
                        ${msg.timestamp}
                        ${isSent ? '<i data-lucide="check-check" style="width:10px; height:10px; color:var(--primary);"></i>' : ''}
                    </span>
                `;
                // Insert before typing indicator
                const typingNode = document.getElementById("chat-typing-container");
                scroller.insertBefore(bubble, typingNode);
                scroller.scrollTop = scroller.scrollHeight;
                
                if (window.lucide) window.lucide.createIcons();
            } else {
                // Not in active chat window thread, reload chat list summaries
                renderChatView(document.getElementById("view-container"));
            }
        } else {
            // Notify user in system bar
            showPopMessage(`New chat from message sender!`, 'info');
        }
    });

    socket.on('opp_typing', (data) => {
        const indicator = document.getElementById("chat-typing-container");
        if (indicator) {
            indicator.style.display = data.typing ? "flex" : "none";
            const scroller = document.getElementById("chat-messages-scroll");
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }
    });
}

async function refreshBellNotificationCount() {
    try {
        const list = await apiFetch('/notifications');
        state.notifications = list;
        const unreadCount = list.filter(n => !n.read).length;
        const badge = document.getElementById("notif-badge");
        if (badge) {
            if (unreadCount > 0) {
                badge.innerText = unreadCount;
                badge.style.display = "flex";
            } else {
                badge.style.display = "none";
            }
        }
    } catch(e) {}
}

// Router routing table
async function handleRouting() {
    const hash = window.location.hash || "#auth";
    const appMain = document.getElementById("view-container");
    
    closeModal();

    const activeRoute = hash.split("?")[0].replace("#", "");
    updateNavSelection(activeRoute);

    if (!token && activeRoute !== "auth" && activeRoute !== "onboarding") {
        window.location.hash = "#auth";
        return;
    }

    switch (activeRoute) {
        case "auth":
            renderAuthView(appMain);
            break;
        case "onboarding":
            renderOnboardingView(appMain);
            break;
        case "home":
            renderHomeView(appMain);
            break;
        case "explore":
            renderExploreView(appMain);
            break;
        case "create":
            renderCreateView(appMain);
            break;
        case "saved":
            renderSavedView(appMain);
            break;
        case "profile":
            renderProfileView(appMain);
            break;
        case "details":
            renderDetailsView(appMain);
            break;
        case "dashboard":
            renderDashboardView(appMain);
            break;
        case "chat":
            renderChatView(appMain);
            break;
        case "notifications":
            renderNotificationsView(appMain);
            break;
        case "settings":
            renderSettingsView(appMain);
            break;
        default:
            window.location.hash = "#home";
    }
    
    if (window.lucide) {
        window.lucide.createIcons();
    }
    
    document.getElementById("app-main").scrollTop = 0;
}

function updateNavSelection(route) {
    document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.toggle("active", item.getAttribute("data-tab") === route);
    });
    document.querySelectorAll(".mobile-nav-item").forEach(item => {
        item.classList.toggle("active", item.getAttribute("data-tab") === route);
    });
    
    const header = document.getElementById("app-header");
    const mNav = document.getElementById("mobile-nav");
    if (route === "auth" || route === "onboarding") {
        if (header) header.style.display = "none";
        if (mNav) mNav.style.display = "none";
    } else {
        if (header) header.style.display = "flex";
        if (mNav) mNav.style.display = "flex";
    }
}

// ----------------------------------------------------
// AUTH VIEWS
// ----------------------------------------------------

function renderAuthView(container) {
    container.innerHTML = `
        <div class="container-card onboarding-card text-center" style="margin-top: 60px;">
            <div class="logo-circle" style="width: 60px; height: 60px; margin: 0 auto 16px auto; border-radius: var(--radius-lg);">
                <i data-lucide="sparkles" style="width: 32px; height: 32px;"></i>
            </div>
            <h1 style="font-size: 26px; font-weight: 700; margin-bottom: 8px;">Welcome to Melo</h1>
            <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 30px;">Discover real-life gatherings & build trusted local communities.</p>
            
            <div class="dashboard-tabs" style="justify-content: center; border-bottom: 1px solid var(--border); margin-bottom: 24px;">
                <button class="dash-tab active" id="tab-phone" onclick="toggleAuthMethod('phone')">Phone & OTP</button>
                <button class="dash-tab" id="tab-email" onclick="toggleAuthMethod('email')">Email & Password</button>
            </div>

            <!-- Phone + OTP Form -->
            <form id="auth-phone-form" onsubmit="handleAuthSubmit(event, 'phone')">
                <div class="form-group" style="text-align: left;">
                    <label class="form-label">Mobile Number</label>
                    <input type="tel" class="form-input" placeholder="+1 (555) 019-2834" required id="auth-phone-input">
                </div>
                <div class="form-group" id="otp-group" style="display: none; text-align: left;">
                    <label class="form-label">6-Digit OTP</label>
                    <input type="text" class="form-input" placeholder="000 000" maxlength="6" id="auth-otp-input">
                </div>
                <button type="submit" class="btn btn-primary btn-full" id="auth-submit-btn">Send OTP Code</button>
            </form>

            <!-- Email + Password Form -->
            <form id="auth-email-form" onsubmit="handleAuthSubmit(event, 'email')" style="display: none;">
                <div class="form-group" style="text-align: left;">
                    <label class="form-label">Email Address</label>
                    <input type="email" class="form-input" placeholder="you@example.com" id="auth-email-input">
                </div>
                <div class="form-group" style="text-align: left;">
                    <label class="form-label">Password</label>
                    <input type="password" class="form-input" placeholder="••••••••" id="auth-pass-input">
                </div>
                <button type="submit" class="btn btn-primary btn-full">Login / Register</button>
            </form>

            <div style="margin: 20px 0; display: flex; align-items: center; justify-content: center; gap: 10px;">
                <div style="height: 1px; flex: 1; background-color: var(--border);"></div>
                <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;">or</span>
                <div style="height: 1px; flex: 1; background-color: var(--border);"></div>
            </div>

            <button class="btn btn-outline btn-full" onclick="handleGoogleSignIn()" style="background-color: var(--bg-surface);">
                Sign In with Google
            </button>
        </div>
    `;
}

let activeAuthMode = "phone";
let otpSent = false;

window.toggleAuthMethod = function(method) {
    activeAuthMode = method;
    document.getElementById("tab-phone").classList.toggle("active", method === "phone");
    document.getElementById("tab-email").classList.toggle("active", method === "email");
    document.getElementById("auth-phone-form").style.display = method === "phone" ? "block" : "none";
    document.getElementById("auth-email-form").style.display = method === "email" ? "block" : "none";
};

window.handleAuthSubmit = async function(event, method) {
    event.preventDefault();
    
    if (method === "phone") {
        if (!otpSent) {
            const phoneVal = document.getElementById("auth-phone-input").value;
            if (!phoneVal.trim()) return;
            otpSent = true;
            document.getElementById("otp-group").style.display = "block";
            document.getElementById("auth-otp-input").required = true;
            document.getElementById("auth-submit-btn").innerText = "Verify OTP & Continue";
            showPopMessage("OTP Sent! Enter 123456 to bypass.", "info");
        } else {
            const otpVal = document.getElementById("auth-otp-input").value;
            if (otpVal === "123456" || otpVal.length === 6) {
                const phone = document.getElementById("auth-phone-input").value;
                try {
                    const res = await apiFetch('/auth/login-register', {
                        method: 'POST',
                        body: JSON.stringify({ phone })
                    });
                    loginComplete(res);
                } catch(e) {}
            } else {
                showPopMessage("Invalid OTP code. Try 123456.", "danger");
            }
        }
    } else {
        const email = document.getElementById("auth-email-input").value;
        const password = document.getElementById("auth-pass-input").value;
        if (!email.trim() || password.length < 4) {
            showPopMessage("Invalid email credentials.", "danger");
            return;
        }
        try {
            const res = await apiFetch('/auth/login-register', {
                method: 'POST',
                body: JSON.stringify({ email, password })
            });
            loginComplete(res);
        } catch(e) {}
    }
};

window.handleGoogleSignIn = async function() {
    try {
        const res = await apiFetch('/auth/login-register', {
            method: 'POST',
            body: JSON.stringify({ email: 'google.user@gmail.com' })
        });
        loginComplete(res);
    } catch(e) {}
};

function loginComplete(res) {
    token = res.token;
    state.currentUser = res.user;
    localStorage.setItem("melo_jwt_token", token);
    
    showPopMessage(`Logged in as ${res.user.name}!`, 'success');
    initWebSockets();
    refreshBellNotificationCount();

    // Check if onboarding values are needed
    if (!res.user.city || !res.user.bio) {
        window.location.hash = "#onboarding";
    } else {
        window.location.hash = "#home";
    }
}

// ----------------------------------------------------
// ONBOARDING VIEW
// ----------------------------------------------------

function renderOnboardingView(container) {
    container.innerHTML = `
        <div class="container-card onboarding-card">
            <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px;">Complete Your Profile</h1>
            <p style="color: var(--text-muted); font-size: 13.5px; margin-bottom: 24px;">Tell the community about yourself to start hosting and joining gatherings.</p>
            
            <form onsubmit="handleOnboardingSubmit(event)">
                <div class="avatar-upload-area">
                    <div class="avatar-upload-preview" onclick="simulateAvatarUpload()">
                        <img id="avatar-preview-img" src="${state.currentUser.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150'}" alt="Profile preview">
                        <div class="profile-edit-badge"><i data-lucide="camera" style="width:12px; height:12px;"></i></div>
                    </div>
                    <span style="font-size: 12px; color: var(--text-muted);">Tap to change profile picture</span>
                    <input type="hidden" id="onboard-avatar-val" value="${state.currentUser.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150'}">
                </div>

                <div class="form-group">
                    <label class="form-label">Full Name</label>
                    <input type="text" class="form-input" id="onboard-name" value="${state.currentUser.name || ''}" required>
                </div>

                <div class="form-group">
                    <label class="form-label">Username</label>
                    <input type="text" class="form-input" id="onboard-username" value="${state.currentUser.username || ''}" required>
                </div>

                <div class="grid-cards" style="grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 0 0 20px 0;">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">Date of Birth</label>
                        <input type="date" class="form-input" id="onboard-dob" value="${state.currentUser.dob || ''}" required>
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">Gender (Optional)</label>
                        <select class="form-input" id="onboard-gender">
                            <option value="">Select Gender</option>
                            <option value="Male" ${state.currentUser.gender === 'Male' ? 'selected' : ''}>Male</option>
                            <option value="Female" ${state.currentUser.gender === 'Female' ? 'selected' : ''}>Female</option>
                            <option value="Non-binary" ${state.currentUser.gender === 'Non-binary' ? 'selected' : ''}>Non-binary</option>
                            <option value="Prefer not to say" ${state.currentUser.gender === 'Prefer not to say' ? 'selected' : ''}>Prefer not to say</option>
                        </select>
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-label">Your Location City</label>
                    <input type="text" class="form-input" id="onboard-city" value="${state.currentUser.city || ''}" placeholder="San Francisco" required>
                </div>

                <div class="form-group">
                    <label class="form-label">Short Bio</label>
                    <textarea class="form-input" id="onboard-bio" placeholder="Coffee geek, trail hiker, and board game lover..." required>${state.currentUser.bio || ''}</textarea>
                </div>

                <div class="form-group">
                    <label class="form-label">Select Your Interests (Multiple)</label>
                    <div style="display:flex; flex-wrap:wrap; gap:8px;" id="interests-selection-area"></div>
                </div>

                <div class="form-group">
                    <label class="form-label">Languages Spoken (Comma separated)</label>
                    <input type="text" class="form-input" id="onboard-languages" value="${state.currentUser.languages.join(', ') || ''}" placeholder="English, Spanish">
                </div>

                <button type="submit" class="btn btn-primary btn-full" style="margin-top: 10px;">Save Profile & Enter Melo</button>
            </form>
        </div>
    `;

    const categories = [
        "Birthday", "House Party", "Coffee Meetup", "Dinner", "Movie Night", "Gaming", 
        "Book Club", "Sports", "Hiking", "Cycling", "Photography", "Music", "Startup Networking", "Volunteer"
    ];
    const selectArea = document.getElementById("interests-selection-area");
    categories.forEach(cat => {
        const item = document.createElement("div");
        const isSel = state.currentUser.interests.includes(cat);
        item.className = `category-pill ${isSel ? 'active' : ''}`;
        item.innerHTML = cat;
        item.onclick = function() {
            item.classList.toggle("active");
        };
        selectArea.appendChild(item);
    });
}

window.simulateAvatarUpload = function() {
    const randomAvatars = [
        "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150",
        "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150",
        "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150"
    ];
    const selected = randomAvatars[Math.floor(Math.random() * randomAvatars.length)];
    document.getElementById("avatar-preview-img").src = selected;
    document.getElementById("onboard-avatar-val").value = selected;
    showPopMessage("Simulated new avatar photo upload!", "success");
};

window.handleOnboardingSubmit = async function(event) {
    event.preventDefault();
    
    const selectedPills = document.querySelectorAll("#interests-selection-area .category-pill.active");
    const interests = Array.from(selectedPills).map(p => p.innerText);

    const rawLangs = document.getElementById("onboard-languages").value;
    const languages = rawLangs.split(",").map(l => l.trim()).filter(l => l.length > 0);

    const profileBody = {
        name: document.getElementById("onboard-name").value,
        username: document.getElementById("onboard-username").value,
        avatar: document.getElementById("onboard-avatar-val").value,
        bio: document.getElementById("onboard-bio").value,
        city: document.getElementById("onboard-city").value,
        dob: document.getElementById("onboard-dob").value,
        gender: document.getElementById("onboard-gender").value,
        interests,
        languages
    };

    try {
        const res = await apiFetch('/auth/profile', {
            method: 'POST',
            body: JSON.stringify(profileBody)
        });
        state.currentUser = res.user;
        showPopMessage("Profile updated!", "success");
        window.location.hash = "#home";
    } catch(e) {}
};

// ----------------------------------------------------
// HOME VIEW
// ----------------------------------------------------

async function renderHomeView(container) {
    const greeting = getGreetingTime();
    
    container.innerHTML = `
        <div class="greeting-section">
            <h1 class="greeting-title">${greeting}, ${state.currentUser.name}!</h1>
            <p class="greeting-subtitle">Find something fun to do with people nearby today.</p>
        </div>

        <div class="search-bar-container">
            <i data-lucide="search" class="search-icon"></i>
            <input type="text" class="main-search-input" placeholder="Search gatherings..." onkeydown="handleHomeSearch(event)">
            <button class="filter-icon-btn" onclick="openExploreFilters()">
                <i data-lucide="sliders"></i>
            </button>
        </div>

        <div class="section-header">
            <h2 class="section-title">Popular Categories</h2>
        </div>
        <div class="horizontal-scroller" id="home-categories-scroller"></div>

        <div class="section-header">
            <h2 class="section-title">Featured Social Gatherings</h2>
            <button class="section-link" onclick="window.location.hash = '#explore'">View All</button>
        </div>
        <div class="grid-cards" id="home-featured-grid">
            <div class="skeleton skeleton-card" style="grid-column: 1/-1;"></div>
        </div>
    `;

    renderCategoriesScroller();
    
    try {
        // Fetch active events list
        const list = await apiFetch('/gatherings');
        state.gatherings = list;
        
        // Load bookmarks saved status
        const savedList = await apiFetch('/saved');
        state.savedGatherings = savedList.map(g => g.id);

        const grid = document.getElementById("home-featured-grid");
        grid.innerHTML = "";

        if (list.length === 0) {
            grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:24px; color:var(--text-muted);">No social gatherings today. Go host one!</div>`;
        } else {
            list.slice(0, 3).forEach(event => {
                grid.appendChild(createEventCardHTML(event));
            });
        }
        if (window.lucide) window.lucide.createIcons();
    } catch(e) {}
}

function getGreetingTime() {
    const hrs = new Date().getHours();
    if (hrs < 12) return "Good morning";
    if (hrs < 18) return "Good afternoon";
    return "Good evening";
}

function renderCategoriesScroller() {
    const list = [
        { name: "Coffee Meetup", icon: "coffee" },
        { name: "Dinner", icon: "utensils" },
        { name: "Hiking", icon: "mountain" },
        { name: "Gaming", icon: "gamepad-2" },
        { name: "Book Club", icon: "book-open" },
        { name: "Movie Night", icon: "film" }
    ];
    const target = document.getElementById("home-categories-scroller");
    if (!target) return;

    list.forEach(item => {
        const pill = document.createElement("div");
        pill.className = "category-pill";
        pill.innerHTML = `<i data-lucide="${item.icon}" style="width:14px; height:14px;"></i> ${item.name}`;
        pill.onclick = function() {
            window.location.hash = `#explore?category=${encodeURIComponent(item.name)}`;
        };
        target.appendChild(pill);
    });
}

// ----------------------------------------------------
// EVENT CARD COMPONENT
// ----------------------------------------------------

function createEventCardHTML(event) {
    const isSaved = state.savedGatherings.includes(event.id);
    const card = document.createElement("div");
    card.className = "event-card";
    card.onclick = function(e) {
        if (e.target.closest(".card-save-btn") || e.target.closest(".btn-join-card")) return;
        window.location.hash = `#details?id=${event.id}`;
    };

    const isJoined = event.attendees.includes(state.currentUser.id);
    const isPending = event.requests.includes(state.currentUser.id);
    
    let joinBtnText = "Join";
    let joinClass = "btn-secondary";
    if (isJoined) {
        joinBtnText = "Joined";
        joinClass = "btn-outline";
    } else if (isPending) {
        joinBtnText = "Pending";
        joinClass = "btn-outline";
    }

    card.innerHTML = `
        <div class="card-img-wrapper">
            <img class="card-img" src="${event.coverImage || 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=500'}" alt="${event.title}">
            <span class="badge-tag ${event.public ? 'badge-success' : 'badge-warning'} card-badge">
                <i data-lucide="${event.public ? 'globe' : 'lock'}" style="width:10px; height:10px;"></i> 
                ${event.public ? 'Public' : 'Private'}
            </span>
            <button class="card-save-btn ${isSaved ? 'saved' : ''}" onclick="toggleSaveEvent(event, ${event.id})">
                <i data-lucide="heart" style="width:16px; height:16px; ${isSaved ? 'fill: var(--danger); stroke: var(--danger);' : ''}"></i>
            </button>
        </div>
        <div class="card-body">
            <div class="card-meta">
                <span>${event.category}</span>
                <span>•</span>
                <span>${event.distance}</span>
            </div>
            <h3 class="card-title">${event.title}</h3>
            
            <div class="card-details-row">
                <i data-lucide="calendar"></i>
                <span>${formatDateString(event.date)} at ${event.time}</span>
            </div>
            <div class="card-details-row" style="margin-bottom: 12px;">
                <i data-lucide="map-pin"></i>
                <span>${event.venue}</span>
            </div>

            <div class="card-footer">
                <div class="card-host">
                    <img class="card-host-avatar" src="${event.host.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}" alt="${event.host.name}">
                    <span class="card-host-name">${event.host.name}</span>
                </div>
                <span class="card-capacity">${event.attendeeCount} / ${event.maxAttendees} Going</span>
            </div>
            
            <button class="btn btn-sm btn-full ${joinClass} btn-join-card" style="margin-top: 14px;" onclick="handleCardJoinBtn(this, ${event.id})">
                ${joinBtnText}
            </button>
        </div>
    `;
    
    return card;
}

window.toggleSaveEvent = async function(e, id) {
    e.stopPropagation();
    const isSaved = state.savedGatherings.includes(id);
    try {
        if (isSaved) {
            await apiFetch(`/saved/${id}`, { method: 'DELETE' });
            state.savedGatherings = state.savedGatherings.filter(savedId => savedId !== id);
            showPopMessage("Removed event bookmark.", "info");
        } else {
            await apiFetch(`/saved/${id}`, { method: 'POST' });
            state.savedGatherings.push(id);
            showPopMessage("Bookmarked gathering!", "success");
        }
        
        const btn = e.currentTarget;
        btn.classList.toggle("saved", !isSaved);
        const icon = btn.querySelector("i");
        if (!isSaved) {
            icon.style.fill = "var(--danger)";
            icon.style.stroke = "var(--danger)";
        } else {
            icon.style.fill = "none";
            icon.style.stroke = "var(--text-muted)";
        }
    } catch(err) {}
};

window.handleCardJoinBtn = async function(btnElement, id) {
    const event = state.gatherings.find(g => g.id === id);
    if (!event) return;

    const isJoined = event.attendees.includes(state.currentUser.id);
    const isPending = event.requests.includes(state.currentUser.id);

    try {
        if (isJoined || isPending) {
            // Leave
            await apiFetch(`/gatherings/${id}/leave`, { method: 'POST' });
            event.attendees = event.attendees.filter(uid => uid !== state.currentUser.id);
            event.requests = event.requests.filter(uid => uid !== state.currentUser.id);
            event.attendeeCount--;
            
            btnElement.innerText = "Join";
            btnElement.className = "btn btn-sm btn-full btn-secondary btn-join-card";
            showPopMessage("Cancelled RSVP.", "info");
        } else {
            // Join
            const res = await apiFetch(`/gatherings/${id}/join`, { method: 'POST' });
            if (res.status === 'joined') {
                event.attendees.push(state.currentUser.id);
                event.attendeeCount++;
                btnElement.innerText = "Joined";
                btnElement.className = "btn btn-sm btn-full btn-outline btn-join-card";
                showPopMessage("RSVP confirmed!", "success");
            } else {
                event.requests.push(state.currentUser.id);
                btnElement.innerText = "Pending";
                btnElement.className = "btn btn-sm btn-full btn-outline btn-join-card";
                showPopMessage("RSVP request pending approval.", "info");
            }
        }
        // Update capacity counter
        const card = btnElement.closest(".event-card");
        const cap = card.querySelector(".card-capacity");
        if (cap) cap.innerText = `${event.attendeeCount} / ${event.maxAttendees} Going`;
    } catch(e) {}
};

// ----------------------------------------------------
// EXPLORE SCREEN
// ----------------------------------------------------

async function renderExploreView(container) {
    const hashSplit = window.location.hash.split("?");
    let searchVal = state.searchQuery || "";
    if (hashSplit.length > 1) {
        const params = new URLSearchParams(hashSplit[1]);
        if (params.get("search")) searchVal = decodeURIComponent(params.get("search"));
        if (params.get("category")) activeFilters.category = decodeURIComponent(params.get("category"));
    }

    container.innerHTML = `
        <div class="greeting-section">
            <h1 class="greeting-title">Explore Social Gatherings</h1>
            <p class="greeting-subtitle">Filter by interest, dates, locations, or group limits.</p>
        </div>

        <div class="search-bar-container" style="margin-bottom: 20px;">
            <i data-lucide="search" class="search-icon"></i>
            <input type="text" id="explore-search-input" class="main-search-input" placeholder="Search gatherings..." value="${searchVal}" oninput="triggerExploreSearch()">
            <button class="filter-icon-btn" onclick="openExploreFilters()">
                <i data-lucide="sliders"></i>
            </button>
        </div>

        <div class="filters-bar" id="explore-category-scroll"></div>

        <div class="filters-bar" style="border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 20px;">
            <span class="filter-pill ${activeFilters.date === 'today' ? 'active' : ''}" onclick="toggleDateFilter('today')">Today</span>
            <span class="filter-pill ${activeFilters.date === 'tomorrow' ? 'active' : ''}" onclick="toggleDateFilter('tomorrow')">Tomorrow</span>
            <span class="filter-pill ${activeFilters.date === 'weekend' ? 'active' : ''}" onclick="toggleDateFilter('weekend')">Weekend</span>
            <span class="filter-pill ${activeFilters.free ? 'active' : ''}" onclick="toggleToggleFilter('free')">Free Entry</span>
            <span class="filter-pill ${activeFilters.age18 ? 'active' : ''}" onclick="toggleToggleFilter('age18')">18+ Age</span>
            <span class="filter-pill ${activeFilters.smallGroup ? 'active' : ''}" onclick="toggleToggleFilter('smallGroup')">Small Group (<10)</span>
        </div>

        <div class="grid-cards" id="explore-results-grid">
            <div class="skeleton skeleton-card" style="grid-column: 1/-1;"></div>
        </div>
    `;

    renderExploreCategoryFilters();
    renderExploreResults();
}

// ----------------------------------------------------
// EVENT DETAILS VIEW
// ----------------------------------------------------

async function renderDetailsView(container) {
    const hashSplit = window.location.hash.split("?");
    if (hashSplit.length < 2) {
        window.location.hash = "#home";
        return;
    }
    const params = new URLSearchParams(hashSplit[1]);
    const eventId = parseInt(params.get("id"));

    try {
        const event = await apiFetch(`/gatherings/${eventId}`);
        const isSaved = state.savedGatherings.includes(event.id);
        const isHost = event.hostId === state.currentUser.id;

        // RSVP status widgets
        let joinStatusHtml = "";
        if (isHost) {
            joinStatusHtml = `
                <div class="glass-card text-center" style="border-color: var(--primary);">
                    <span class="badge-tag badge-primary" style="margin-bottom:8px;">You are Host</span>
                    <p style="font-size:13px; margin-bottom:14px; color:var(--text-secondary);">Manage guest approval lists in your dashboard.</p>
                    <button class="btn btn-primary btn-full" onclick="window.location.hash = '#dashboard'">Go to Dashboard</button>
                </div>
            `;
        } else {
            const isJoined = event.attendees.includes(state.currentUser.id);
            const isPending = event.requests.includes(state.currentUser.id);

            if (isJoined) {
                joinStatusHtml = `
                    <div class="glass-card text-center" style="border-color: var(--success);">
                        <div style="color:var(--success); font-weight:700; font-size:15px; margin-bottom:8px; display:flex; align-items:center; justify-content:center; gap:6px;">
                            <i data-lucide="check-circle-2"></i> You're Attending
                        </div>
                        <button class="btn btn-outline btn-full btn-sm" onclick="leaveEventDetails(${event.id})">Leave Gathering</button>
                    </div>
                `;
            } else if (isPending) {
                joinStatusHtml = `
                    <div class="glass-card text-center" style="border-color: var(--warning);">
                        <div style="color:var(--warning); font-weight:700; font-size:15px; margin-bottom:8px; display:flex; align-items:center; justify-content:center; gap:6px;">
                            <i data-lucide="clock"></i> Request Pending
                        </div>
                        <button class="btn btn-outline btn-full btn-sm" onclick="leaveEventDetails(${event.id})">Cancel Request</button>
                    </div>
                `;
            } else {
                if (event.attendees.length >= event.maxAttendees) {
                    joinStatusHtml = `
                        <div class="glass-card text-center">
                            <span class="badge-tag badge-danger" style="margin-bottom:8px;">Full House</span>
                        </div>
                    `;
                } else {
                    joinStatusHtml = `
                        <div class="glass-card text-center">
                            <h3 style="font-size:16px; font-weight:700; margin-bottom:4px;">Ready to Join?</h3>
                            <button class="btn btn-primary btn-full" onclick="joinEventDetails(${event.id})">
                                ${event.public ? "Join Gathering" : "Request Invitation"}
                            </button>
                        </div>
                    `;
                }
            }
        }

        container.innerHTML = `
            <div class="details-cover">
                <img class="details-cover-img" src="${event.coverImage || 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=1200'}" alt="${event.title}">
                <div class="details-cover-actions">
                    <button class="back-btn-details" onclick="window.history.back()">
                        <i data-lucide="arrow-left"></i>
                    </button>
                    <div style="display:flex; gap:10px;">
                        <button class="action-btn-circle" onclick="toggleSaveEventDetails(this, ${event.id})">
                            <i data-lucide="heart" style="${isSaved ? 'fill: var(--danger); stroke: var(--danger);' : ''}"></i>
                        </button>
                        <button class="action-btn-circle" onclick="openShareGathering(${event.id})">
                            <i data-lucide="share-2"></i>
                        </button>
                    </div>
                </div>
            </div>

            <div class="details-layout">
                <div class="details-main-content">
                    <div class="details-title-row">
                        <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
                            <span class="badge-tag badge-primary">${event.category}</span>
                            ${event.public ? '<span class="badge-tag badge-success">Public</span>' : '<span class="badge-tag badge-warning">Private</span>'}
                        </div>
                        <h1>${event.title}</h1>
                    </div>

                    <div class="host-profile-box">
                        <div class="host-info" onclick="viewUserProfile('${event.host.username}')" style="cursor:pointer;">
                            <img class="host-avatar" src="${event.host.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}" alt="${event.host.name}">
                            <div class="host-badge-area">
                                <span class="host-lbl">Hosted By</span>
                                <span class="host-name">${event.host.name} <span class="verification-badge"><i data-lucide="badge-check" style="width:14px; height:14px; fill:var(--primary-light); color:var(--primary);"></i></span></span>
                            </div>
                        </div>
                        ${!isHost ? `<button class="btn btn-secondary btn-sm" onclick="startChatWithHost('${event.hostId}')">Message Host</button>` : ''}
                    </div>

                    <div>
                        <h3 style="font-size: 16px; font-weight:700; margin-bottom:8px;">About the Gathering</h3>
                        <p style="line-height: 1.6; font-size:14.5px; color:var(--text-secondary);">${event.description}</p>
                    </div>

                    <div class="grid-cards" style="grid-template-columns: repeat(2, 1fr); gap:16px;">
                        <div class="details-card-icon">
                            <div class="icon-box-primary"><i data-lucide="shield-alert" style="width:18px; height:18px;"></i></div>
                            <div class="details-text-box">
                                <h3>Age Policy</h3>
                                <p>${event.ageRestriction}</p>
                            </div>
                        </div>
                        <div class="details-card-icon">
                            <div class="icon-box-primary"><i data-lucide="shirt" style="width:18px; height:18px;"></i></div>
                            <div class="details-text-box">
                                <h3>Dress Code</h3>
                                <p>${event.dressCode || "Casual"}</p>
                            </div>
                        </div>
                        <div class="details-card-icon">
                            <div class="icon-box-primary"><i data-lucide="shopping-bag" style="width:18px; height:18px;"></i></div>
                            <div class="details-text-box">
                                <h3>Things to Bring</h3>
                                <p>${event.itemsToBring || "Just yourself!"}</p>
                            </div>
                        </div>
                        <div class="details-card-icon">
                            <div class="icon-box-primary"><i data-lucide="info" style="width:18px; height:18px;"></i></div>
                            <div class="details-text-box">
                                <h3>Community Rules</h3>
                                <p>${event.rules || "Respect host venue guidelines."}</p>
                            </div>
                        </div>
                    </div>

                    <div class="comments-section">
                        <h3 style="font-size: 16px; font-weight:700;">Comments & Discussion (${event.comments.length})</h3>
                        <div class="comment-list" id="details-comments-list">
                            ${event.comments.length === 0 ? '<p style="color:var(--text-muted); font-size:13px;">No comments yet.</p>' : ''}
                            ${event.comments.map(c => `
                                <div class="comment-item">
                                    <img class="comment-avatar" src="${c.userAvatar}" alt="${c.userName}">
                                    <div class="comment-content-box">
                                        <div class="comment-header">
                                            <span class="comment-name">${c.userName}</span>
                                            <span class="comment-time">${c.time}</span>
                                        </div>
                                        <p class="comment-text">${c.text}</p>
                                    </div>
                                </div>
                            `).join("")}
                        </div>

                        <div class="comment-composer">
                            <img class="comment-avatar" src="${state.currentUser.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}" alt="Your avatar">
                            <div style="flex:1; display:flex; gap:8px;">
                                <input type="text" class="form-input" id="new-comment-input" placeholder="Ask a question or reply to host...">
                                <button class="btn btn-primary btn-sm" onclick="submitComment(${event.id})">Post</button>
                            </div>
                        </div>
                    </div>

                    <div style="margin-top:20px; display:flex; justify-content:flex-end;">
                        <button class="section-link" style="color: var(--danger); font-size:12px;" onclick="openReportModal('gathering', ${event.id})">Report Gathering</button>
                    </div>
                </div>

                <div class="details-sidebar">
                    ${joinStatusHtml}

                    <div class="container-card" style="padding: 20px; display:flex; flex-direction:column; gap:16px;">
                        <div class="details-card-icon">
                            <div class="icon-box-primary"><i data-lucide="calendar" style="width:18px; height:18px;"></i></div>
                            <div class="details-text-box">
                                <h3>Date & Time</h3>
                                <p>${formatDateString(event.date)}</p>
                                <p style="font-size:11px; margin-top:2px;">Starts: ${event.time} | Ends: ${event.endTime || 'Late'}</p>
                            </div>
                        </div>
                        <div class="details-card-icon">
                            <div class="icon-box-primary"><i data-lucide="map-pin" style="width:18px; height:18px;"></i></div>
                            <div class="details-text-box">
                                <h3>Gathering Venue</h3>
                                <p>${event.venue}</p>
                                <p style="font-size:11px; margin-top:2px;">${event.location}</p>
                            </div>
                        </div>

                        <div class="map-placeholder" onclick="openGoogleMapDirections('${event.venue}, ${event.location}')">
                            <img src="https://images.unsplash.com/photo-1524661135-423995f22d0b?w=400" alt="Map mockup">
                            <div class="map-overlay">
                                <span>Open Directions</span>
                                <i data-lucide="navigation" style="width:14px; height:14px;"></i>
                            </div>
                        </div>
                    </div>

                    <div class="container-card" style="padding: 20px;">
                        <h3 style="font-size: 15px; font-weight:700; margin-bottom:12px;">Guests Going (${event.attendeesList.length})</h3>
                        <div style="display:flex; flex-wrap:wrap; gap:12px;">
                            ${event.attendeesList.map(a => `
                                <div style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;" onclick="viewUserProfile('${a.username}')">
                                    <img src="${a.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}" alt="${a.name}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;">
                                    <span style="font-size:10px; color:var(--text-secondary); max-width:50px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${a.name.split(" ")[0]}</span>
                                </div>
                            `).join("")}
                        </div>
                    </div>
                </div>
            </div>
        `;
        if (window.lucide) window.lucide.createIcons();
    } catch(err) {}
}

window.joinEventDetails = async function(id) {
    try {
        await apiFetch(`/gatherings/${id}/join`, { method: 'POST' });
        showPopMessage("RSVP status updated!", "success");
        renderDetailsView(document.getElementById("view-container"));
    } catch(e) {}
};

window.leaveEventDetails = async function(id) {
    try {
        await apiFetch(`/gatherings/${id}/leave`, { method: 'POST' });
        showPopMessage("Cancelled RSVP.", "info");
        renderDetailsView(document.getElementById("view-container"));
    } catch(e) {}
};

window.submitComment = async function(id) {
    const input = document.getElementById("new-comment-input");
    if (!input || input.value.trim() === "") return;

    try {
        await apiFetch(`/gatherings/${id}/comments`, {
            method: 'POST',
            body: JSON.stringify({ text: input.value.trim() })
        });
        input.value = "";
        renderDetailsView(document.getElementById("view-container"));
    } catch(e) {}
};

// ----------------------------------------------------
// CREATE GATHERING
// ----------------------------------------------------

function renderCreateView(container) {
    container.innerHTML = `
        <div class="container-card" style="max-width:650px; margin: 20px auto;">
            <h1 style="font-size:24px; font-weight:700; margin-bottom:8px;">Create a Social Gathering</h1>
            <p style="color:var(--text-muted); font-size:13.5px; margin-bottom:24px;">Host an event to bring local people together.</p>

            <form onsubmit="handleCreateGatheringSubmit(event)">
                <div class="form-group">
                    <label class="form-label">Gathering Title</label>
                    <input type="text" class="form-input" id="create-title" placeholder="Cozy Sunday Board Games & Cider" required>
                </div>

                <div class="form-group">
                    <label class="form-label">Description & Activities</label>
                    <textarea class="form-input" id="create-description" placeholder="Describe the vibe, plans, and who should join..." required></textarea>
                </div>

                <div class="grid-cards" style="grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 0 0 20px 0;">
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Category</label>
                        <select class="form-input" id="create-category" required>
                            <option value="">Select Category</option>
                            <option value="Birthday">Birthday</option>
                            <option value="House Party">House Party</option>
                            <option value="Coffee Meetup">Coffee Meetup</option>
                            <option value="Dinner">Dinner</option>
                            <option value="Movie Night">Movie Night</option>
                            <option value="Gaming">Gaming</option>
                            <option value="Book Club">Book Club</option>
                            <option value="Sports">Sports</option>
                            <option value="Hiking">Hiking</option>
                            <option value="Cycling">Cycling</option>
                            <option value="Photography">Photography</option>
                            <option value="Music">Music</option>
                            <option value="Startup Networking">Startup Networking</option>
                            <option value="Volunteer">Volunteer</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Maximum Guest Capacity</label>
                        <input type="number" class="form-input" id="create-capacity" placeholder="8" min="2" max="100" required>
                    </div>
                </div>

                <div class="grid-cards" style="grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 0 0 20px 0;">
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Event Date</label>
                        <input type="date" class="form-input" id="create-date" required>
                    </div>
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Start Time</label>
                        <input type="time" class="form-input" id="create-time" required>
                    </div>
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">End Time</label>
                        <input type="time" class="form-input" id="create-endtime">
                    </div>
                </div>

                <div class="grid-cards" style="grid-template-columns: repeat(2, 1fr); gap:16px; margin: 0 0 20px 0;">
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Venue Name</label>
                        <input type="text" class="form-input" id="create-venue" placeholder="My apartment" required>
                    </div>
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">City, State</label>
                        <input type="text" class="form-input" id="create-location" placeholder="San Francisco, CA" required>
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-label">Select Cover Backdrop</label>
                    <div style="display:flex; gap:12px; overflow-x:auto; padding-bottom:6px;" id="create-cover-selector"></div>
                    <input type="hidden" id="create-cover-val" required>
                </div>

                <div class="grid-cards" style="grid-template-columns: repeat(2, 1fr); gap:16px; margin: 0 0 20px 0;">
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Age Restrictions</label>
                        <select class="form-input" id="create-age">
                            <option value="All ages">All ages</option>
                            <option value="Age 18+">Age 18+</option>
                            <option value="Age 21+">Age 21+</option>
                        </select>
                    </div>
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Dress Code (Optional)</label>
                        <input type="text" class="form-input" id="create-dress" placeholder="Casual">
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-label">Things Guests Should Bring (Optional)</label>
                    <input type="text" class="form-input" id="create-items" placeholder="Warm jacket, snack">
                </div>

                <div class="form-group">
                    <label class="form-label">Rules / Guidelines</label>
                    <input type="text" class="form-input" id="create-rules" placeholder="Take shoes off...">
                </div>

                <div class="form-group">
                    <label class="form-label">Tags (Comma separated)</label>
                    <input type="text" class="form-input" id="create-tags" placeholder="Outdoors, Social">
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center; background-color:var(--bg); padding:16px; border-radius:var(--radius-md); border:1px solid var(--border); margin-bottom:24px;">
                    <div>
                        <h4 style="font-size:14px; font-weight:700;">Host Approval Required</h4>
                        <p style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">Private event status; you will manually approve guest requests.</p>
                    </div>
                    <label class="checkbox-label">
                        <input type="checkbox" id="create-approval-required">
                    </label>
                </div>

                <button type="submit" class="btn btn-primary btn-full">Host Gathering & Publish</button>
            </form>
        </div>
    `;

    renderCreateCoverOptions();
}

window.handleCreateGatheringSubmit = async function(event) {
    event.preventDefault();

    const body = {
        title: document.getElementById("create-title").value,
        description: document.getElementById("create-description").value,
        category: document.getElementById("create-category").value,
        maxAttendees: parseInt(document.getElementById("create-capacity").value),
        date: document.getElementById("create-date").value,
        time: document.getElementById("create-time").value,
        endTime: document.getElementById("create-endtime").value,
        venue: document.getElementById("create-venue").value,
        location: document.getElementById("create-location").value,
        coverImage: document.getElementById("create-cover-val").value,
        ageRestriction: document.getElementById("create-age").value,
        dressCode: document.getElementById("create-dress").value,
        itemsToBring: document.getElementById("create-items").value,
        rules: document.getElementById("create-rules").value,
        public: !document.getElementById("create-approval-required").checked,
        tags: document.getElementById("create-tags").value.split(",").map(t => t.trim()).filter(t => t.length > 0)
    };

    try {
        await apiFetch('/gatherings', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        showPopMessage("Gathering published successfully!", "success");
        window.location.hash = "#dashboard";
    } catch(e) {}
};

// ----------------------------------------------------
// SAVED SCREEN
// ----------------------------------------------------

async function renderSavedView(container) {
    container.innerHTML = `
        <div class="greeting-section">
            <h1 class="greeting-title">Your Saved Gatherings</h1>
            <p class="greeting-subtitle">Easily bookmark social gatherings to check dates later.</p>
        </div>
        <div class="grid-cards" id="saved-results-grid">
            <div class="skeleton skeleton-card" style="grid-column: 1/-1;"></div>
        </div>
    `;

    try {
        const list = await apiFetch('/saved');
        const grid = document.getElementById("saved-results-grid");
        grid.innerHTML = "";

        if (list.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 40px 24px; color: var(--text-muted);">
                    <i data-lucide="heart" style="width: 48px; height: 48px; stroke-width: 1.5; margin-bottom:12px; color:var(--border);"></i>
                    <h3>No Saved Events</h3>
                </div>
            `;
        } else {
            list.forEach(event => {
                grid.appendChild(createEventCardHTML(event));
            });
        }
        if (window.lucide) window.lucide.createIcons();
    } catch(e) {}
}

// ----------------------------------------------------
// DASHBOARDS
// ----------------------------------------------------

async function renderDashboardView(container) {
    container.innerHTML = `
        <div class="greeting-section">
            <h1 class="greeting-title">Your Gatherings Hub</h1>
            <p class="greeting-subtitle">Approve join requests, manage attendance, and check past events.</p>
        </div>

        <div class="dashboard-tabs">
            <button class="dash-tab ${activeDashboardTab === 'hosting' ? 'active' : ''}" onclick="toggleDashboardTab('hosting')">Hosting Events</button>
            <button class="dash-tab ${activeDashboardTab === 'attending' ? 'active' : ''}" onclick="toggleDashboardTab('attending')">Attending Events</button>
        </div>

        <div id="dashboard-tab-content">
            <div class="skeleton skeleton-text" style="width:100px;"></div>
        </div>
    `;

    await renderDashboardContent();
}

async function renderDashboardContent() {
    const target = document.getElementById("dashboard-tab-content");
    if (!target) return;

    try {
        if (activeDashboardTab === "hosting") {
            const list = await apiFetch('/dashboard/hosting');
            
            if (list.length === 0) {
                target.innerHTML = `<div class="container-card text-center">No hosting events yet.</div>`;
                return;
            }

            let html = "";
            list.forEach(event => {
                const hasRequests = event.requests && event.requests.length > 0;
                let reqHtml = "";
                if (hasRequests) {
                    reqHtml = `
                        <div style="background-color: var(--warning-light); padding:16px; border-radius:var(--radius-md); border:1px solid var(--warning); margin-bottom:14px;">
                            <h4 style="font-size:13px; font-weight:700; margin-bottom:8px;">Pending Join Requests (${event.requests.length})</h4>
                            <div style="display:flex; flex-direction:column; gap:8px;">
                                ${event.requests.map(req => `
                                    <div style="display:flex; justify-content:space-between; align-items:center; background-color:var(--bg-surface); padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border);">
                                        <div style="display:flex; align-items:center; gap:8px;">
                                            <img src="${req.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" style="width:28px; height:28px; border-radius:50%; object-fit:cover;">
                                            <span style="font-size:13px; font-weight:600;">${req.name}</span>
                                        </div>
                                        <div style="display:flex; gap:6px;">
                                            <button class="btn btn-sm btn-outline" style="padding:4px 8px; font-size:11px;" onclick="handleRequest(${event.id}, '${req.id}', 'reject')">Decline</button>
                                            <button class="btn btn-sm btn-primary" style="padding:4px 8px; font-size:11px;" onclick="handleRequest(${event.id}, '${req.id}', 'approve')">Approve</button>
                                        </div>
                                    </div>
                                `).join("")}
                            </div>
                        </div>
                    `;
                }

                html += `
                    <div class="container-card" style="margin-bottom:20px; border-left:4px solid var(--primary);">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                            <div>
                                <span class="badge-tag ${event.status === 'completed' ? 'badge-success' : 'badge-primary'}">${event.category}</span>
                                <h3 style="font-size:17px; font-weight:700; cursor:pointer; margin-top:4px;" onclick="window.location.hash = '#details?id=${event.id}'">${event.title}</h3>
                                <p style="font-size:12.5px; color:var(--text-muted);">${formatDateString(event.date)} at ${event.time} • ${event.venue}</p>
                            </div>
                            <div style="display:flex; gap:6px;">
                                ${event.status !== 'completed' ? `<button class="btn btn-sm btn-secondary" onclick="markCompleted(${event.id})">Complete</button>` : ''}
                                <button class="btn btn-sm btn-outline" style="color:var(--danger);" onclick="deleteHostedGathering(${event.id})">Delete</button>
                            </div>
                        </div>
                        ${reqHtml}
                    </div>
                `;
            });
            target.innerHTML = html;
        } else {
            const data = await apiFetch('/dashboard/attending');
            let html = "";

            if (data.pending.length > 0) {
                html += `<h4 style="font-size:14px; font-weight:700; margin-bottom:12px;">Sent Requests</h4>`;
                data.pending.forEach(event => {
                    html += `
                        <div class="container-card" style="margin-bottom:16px; border-left:4px solid var(--warning);">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <div>
                                    <h3 style="font-size:15px; font-weight:700; cursor:pointer;" onclick="window.location.hash = '#details?id=${event.id}'">${event.title}</h3>
                                </div>
                                <button class="btn btn-sm btn-outline" onclick="leaveEventDetails(${event.id})">Cancel</button>
                            </div>
                        </div>
                    `;
                });
            }

            if (data.attending.length > 0) {
                html += `<h4 style="font-size:14px; font-weight:700; margin-bottom:12px;">Confirmed Events</h4>`;
                data.attending.forEach(event => {
                    html += `
                        <div class="container-card" style="margin-bottom:16px; border-left:4px solid var(--success);">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <div>
                                    <h3 style="font-size:15px; font-weight:700; cursor:pointer;" onclick="window.location.hash = '#details?id=${event.id}'">${event.title}</h3>
                                    <p style="font-size:12px; color:var(--text-muted);">${formatDateString(event.date)} at ${event.time}</p>
                                </div>
                                <div style="display:flex; gap:6px;">
                                    <button class="btn btn-sm btn-secondary" onclick="startChatWithHost('${event.hostId}')">Message Host</button>
                                    <button class="btn btn-sm btn-outline" style="color:var(--danger);" onclick="leaveEventDetails(${event.id})">Leave</button>
                                </div>
                            </div>
                        </div>
                    `;
                });
            }

            if (data.pending.length === 0 && data.attending.length === 0) {
                target.innerHTML = `<div class="container-card text-center">No attending socials yet.</div>`;
                return;
            }
            target.innerHTML = html;
        }
        if (window.lucide) window.lucide.createIcons();
    } catch(e) {}
}

window.handleRequest = async function(eventId, userId, action) {
    try {
        await apiFetch(`/gatherings/${eventId}/requests`, {
            method: 'PUT',
            body: JSON.stringify({ userId, action })
        });
        showPopMessage("Request updated successfully!", "success");
        renderDashboardContent();
    } catch(e) {}
};

window.markCompleted = async function(id) {
    try {
        await apiFetch(`/gatherings/${id}/complete`, { method: 'POST' });
        showPopMessage("Event completed!", "success");
        renderDashboardContent();
    } catch(e) {}
};

window.deleteHostedGathering = async function(id) {
    if (confirm("Delete this gathering?")) {
        try {
            await apiFetch(`/gatherings/${id}`, { method: 'DELETE' });
            showPopMessage("Deleted event.", "info");
            renderDashboardContent();
        } catch(e) {}
    }
};

// ----------------------------------------------------
// CHAT VIEWS
// ----------------------------------------------------

let activeThreadId = null;

async function renderChatView(container) {
    const hashSplit = window.location.hash.split("?");
    let initialWithUserId = null;
    if (hashSplit.length > 1) {
        const params = new URLSearchParams(hashSplit[1]);
        initialWithUserId = params.get("with");
    }

    try {
        // Fetch active chat thread list
        const threads = await apiFetch('/chats');
        state.chats = threads;

        if (initialWithUserId && initialWithUserId !== state.currentUser.id) {
            const oppUser = await apiFetch(`/users/${initialWithUserId}`).catch(() => null);
            let matching = threads.find(t => t.userA === initialWithUserId || t.userB === initialWithUserId);
            if (!matching && oppUser) {
                matching = {
                    id: `chat_${state.currentUser.id}_${initialWithUserId}`,
                    userA: state.currentUser.id,
                    userB: initialWithUserId,
                    oppUser,
                    lastMsg: null
                };
                threads.unshift(matching);
            }
            activeThreadId = matching ? matching.id : null;
        } else if (threads.length > 0 && !activeThreadId) {
            activeThreadId = threads[0].id;
        }

        container.innerHTML = `
            <div class="chat-container ${activeThreadId ? 'thread-open' : ''}">
                <div class="chat-threads-sidebar">
                    <div class="threads-header">Messages</div>
                    <div class="threads-list" id="chat-sidebar-threads-list"></div>
                </div>
                <div class="chat-active-window">
                    <div id="chat-window-pane"></div>
                </div>
            </div>
        `;

        renderChatThreadsList(threads);
        renderActiveChatWindow();
    } catch(e) {}
}

function renderChatThreadsList(threads) {
    const target = document.getElementById("chat-sidebar-threads-list");
    if (!target) return;

    if (threads.length === 0) {
        target.innerHTML = `<div style="padding:24px; text-align:center; color:var(--text-muted);">No messages yet.</div>`;
        return;
    }

    target.innerHTML = "";
    threads.forEach(thread => {
        const oppUser = thread.oppUser;
        const lastMsg = thread.lastMsg || { text: "No messages yet", timestamp: "" };
        const isActive = thread.id === activeThreadId;

        const div = document.createElement("div");
        div.className = `thread-item ${isActive ? 'active' : ''}`;
        div.onclick = function() {
            activeThreadId = thread.id;
            window.location.hash = "#chat";
            renderChatView(document.getElementById("view-container"));
        };

        div.innerHTML = `
            <img class="thread-avatar" src="${oppUser.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" alt="${oppUser.name}">
            <div class="thread-details">
                <div class="thread-name-row">
                    <span class="thread-name">${oppUser.name}</span>
                    <span class="thread-time">${lastMsg.timestamp}</span>
                </div>
                <div class="thread-last-msg">${lastMsg.text}</div>
            </div>
        `;
        target.appendChild(div);
    });
}

async function renderActiveChatWindow() {
    const pane = document.getElementById("chat-window-pane");
    if (!pane || !activeThreadId) return;

    const thread = state.chats.find(c => c.id === activeThreadId);
    if (!thread) return;

    const oppUser = thread.oppUser;

    try {
        const messages = await apiFetch(`/chats/${oppUser.id}`);
        
        pane.parentNode.innerHTML = `
            <div class="chat-window-header">
                <div class="chat-header-profile" onclick="viewUserProfile('${oppUser.username}')" style="cursor:pointer;">
                    <button class="back-btn-details mobile-only" style="width:32px; height:32px; margin-right:8px; display:none;" onclick="closeMobileChatThread(event)">
                        <i data-lucide="arrow-left" style="width:16px; height:16px;"></i>
                    </button>
                    <img src="${oppUser.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;">
                    <div>
                        <h4 style="font-size:14px; font-weight:700;">${oppUser.name}</h4>
                        <p style="font-size:11px; color:var(--text-muted);">Active now</p>
                    </div>
                </div>
                <button class="icon-button" onclick="openSafetyOptions('${oppUser.id}')">
                    <i data-lucide="shield-alert"></i>
                </button>
            </div>

            <div class="chat-messages-area" id="chat-messages-scroll">
                ${messages.length === 0 ? `<div style="text-align:center; color:var(--text-muted); font-size:12px; margin:40px 0;">This is the beginning of your chat.</div>` : ''}
                ${messages.map(m => {
                    const isSent = m.sender_id === state.currentUser.id;
                    return `
                        <div class="chat-bubble-wrapper ${isSent ? 'sent' : 'received'}">
                            <div class="chat-bubble">${m.text}</div>
                            <span class="chat-bubble-time">
                                ${m.timestamp}
                                ${isSent ? '<i data-lucide="check-check" style="width:10px; height:10px; color:var(--primary);"></i>' : ''}
                            </span>
                        </div>
                    `;
                }).join("")}
                
                <div id="chat-typing-container" style="display:none;">
                    <div class="typing-indicator">
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                    </div>
                </div>
            </div>

            <div class="chat-composer-row">
                <button class="icon-button" onclick="simulateSendImageChat()"><i data-lucide="image"></i></button>
                <div class="chat-input-wrapper">
                    <input type="text" class="chat-input" id="chat-message-input" placeholder="Type a message..." onkeydown="handleChatInputKey(event)">
                    <button class="chat-emoji-trigger" onclick="insertEmojiMock()">😊</button>
                </div>
                <button class="btn btn-primary btn-sm" style="border-radius:50%; width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center;" onclick="submitChatMessage()">
                    <i data-lucide="send" style="width:16px; height:16px;"></i>
                </button>
            </div>
        `;

        const scroller = document.getElementById("chat-messages-scroll");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        if (window.lucide) window.lucide.createIcons();
    } catch(e) {}
}

window.submitChatMessage = function() {
    const input = document.getElementById("chat-message-input");
    if (!input || input.value.trim() === "") return;

    const thread = state.chats.find(c => c.id === activeThreadId);
    if (!thread || !socket) return;

    socket.emit('send_chat', {
        receiverId: thread.oppUser.id,
        text: input.value.trim()
    });

    input.value = "";
};

window.closeMobileChatThread = function(e) {
    e.stopPropagation();
    activeThreadId = null;
    window.location.hash = "#chat";
};

// ----------------------------------------------------
// NOTIFICATIONS
// ----------------------------------------------------

async function renderNotificationsView(container) {
    container.innerHTML = `
        <div class="greeting-section">
            <h1 class="greeting-title">Activity & Notifications</h1>
            <p class="greeting-subtitle">Stay updated on gathering approvals, chat alerts, and reminders.</p>
        </div>
        <div class="container-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h3 style="font-size:16px; font-weight:700;">Recent Updates</h3>
                <button class="section-link" onclick="markAllNotificationsRead()">Mark All Read</button>
            </div>
            <div id="notifications-list-container" style="display:flex; flex-direction:column; gap:12px;"></div>
        </div>
    `;

    await renderNotificationsList();
}

async function renderNotificationsList() {
    const target = document.getElementById("notifications-list-container");
    if (!target) return;

    try {
        const list = await apiFetch('/notifications');
        state.notifications = list;
        
        if (list.length === 0) {
            target.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted);">No notifications yet.</div>`;
            return;
        }

        target.innerHTML = "";
        list.forEach(notif => {
            let icon = "bell";
            let badgeClass = "badge-primary";
            if (notif.type === "approved") { icon = "check-circle"; badgeClass = "badge-success"; }
            if (notif.type === "rejected") { icon = "x-circle"; badgeClass = "badge-danger"; }
            if (notif.type === "request") { icon = "user-plus"; badgeClass = "badge-warning"; }
            if (notif.type === "reminder") { icon = "calendar"; badgeClass = "badge-accent"; }

            const div = document.createElement("div");
            div.style.cssText = `display:flex; gap:12px; padding:14px; border-radius:var(--radius-md); border:1px solid var(--border); background-color: ${notif.read ? 'var(--bg-surface)' : 'var(--primary-light)'};`;
            
            div.innerHTML = `
                <div class="icon-box-primary ${badgeClass}" style="width:34px; height:34px; border-radius:50%;"><i data-lucide="${icon}" style="width:16px; height:16px;"></i></div>
                <div style="flex:1;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
                        <span style="font-size:13px; font-weight:700;">${notif.title}</span>
                        <span style="font-size:10px; color:var(--text-muted);">${notif.time}</span>
                    </div>
                    <p style="font-size:12.5px; color:var(--text-secondary);">${notif.message}</p>
                </div>
            `;
            target.appendChild(div);
        });

        if (window.lucide) window.lucide.createIcons();
    } catch(e) {}
}

window.markAllNotificationsRead = async function() {
    try {
        await apiFetch('/notifications/read', { method: 'PUT' });
        showPopMessage("All marked read.", "success");
        refreshBellNotificationCount();
        renderNotificationsList();
    } catch(e) {}
};

// ----------------------------------------------------
// USER PROFILE SCREEN
// ----------------------------------------------------

async function renderProfileView(container) {
    const hashSplit = window.location.hash.split("?");
    let user = state.currentUser;
    if (hashSplit.length > 1) {
        const params = new URLSearchParams(hashSplit[1]);
        const qUsername = params.get("user");
        if (qUsername) {
            user = await apiFetch(`/users/${qUsername}`).catch(() => state.currentUser);
        }
    }

    const isCurrentUser = user.id === state.currentUser.id;

    container.innerHTML = `
        <div class="profile-cover">
            <div class="profile-avatar-container">
                <img class="profile-avatar-img" src="${user.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}" alt="${user.name}">
            </div>
        </div>

        <div class="container-card">
            <div class="profile-title-area">
                <div>
                    <h1 class="profile-name">
                        ${user.name} 
                        <span class="verification-badge"><i data-lucide="badge-check" style="width:16px; height:16px;"></i></span>
                    </h1>
                    <span class="profile-username">@${user.username} • ${user.city || "San Francisco"}</span>
                </div>

                <div style="display:flex; gap:10px;">
                    ${isCurrentUser ? `
                        <button class="btn btn-secondary btn-sm" onclick="window.location.hash = '#settings'">Settings</button>
                    ` : `
                        <button class="btn btn-primary btn-sm" onclick="startChatWithHost('${user.id}')">Message</button>
                        <button class="btn btn-outline btn-sm" onclick="openSafetyOptions('${user.id}')">Block / Report</button>
                    `}
                </div>
            </div>

            <div class="profile-bio-box">
                <strong>Bio:</strong>
                <p style="margin-top:4px;">${user.bio || "No biography added yet."}</p>
            </div>

            <div style="margin-bottom:20px;">
                <strong>Interests & Hobbies:</strong>
                <div class="interest-tag-container">
                    ${user.interests.length === 0 ? '<span style="color:var(--text-muted); font-size:12px;">No interests selected.</span>' : ''}
                    ${user.interests.map(i => `<span class="interest-tag">${i}</span>`).join("")}
                </div>
            </div>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();
}

// ----------------------------------------------------
// SETTINGS
// ----------------------------------------------------

function renderSettingsView(container) {
    container.innerHTML = `
        <div class="greeting-section">
            <h1 class="greeting-title">Settings</h1>
            <p class="greeting-subtitle">Manage preferences and profile details.</p>
        </div>

        <div class="container-card">
            <h3 style="font-size:16px; font-weight:700; margin-bottom:16px;">Update Bio</h3>
            <form onsubmit="handleSettingsProfileSave(event)">
                <div class="form-group">
                    <label class="form-label">Full Name</label>
                    <input type="text" class="form-input" id="set-name" value="${state.currentUser.name}" required>
                </div>
                <div class="form-group">
                    <label class="form-label">City</label>
                    <input type="text" class="form-input" id="set-city" value="${state.currentUser.city || ''}" required>
                </div>
                <div class="form-group">
                    <label class="form-label">Bio Description</label>
                    <textarea class="form-input" id="set-bio">${state.currentUser.bio || ''}</textarea>
                </div>
                <button type="submit" class="btn btn-primary btn-sm">Save Profile</button>
            </form>
        </div>

        <div class="container-card">
            <h3 style="font-size:16px; font-weight:700; margin-bottom:16px;">Preferences</h3>
            
            <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0;">
                <div>
                    <h4 style="font-size:14px; font-weight:600;">Dark Theme Mode</h4>
                </div>
                <label class="checkbox-label">
                    <input type="checkbox" id="set-dark-mode" ${state.darkMode ? 'checked' : ''} onchange="toggleDarkModeSetting(this)">
                </label>
            </div>
        </div>

        <div class="container-card" style="border:1px solid var(--danger-light);">
            <h3 style="font-size:16px; font-weight:700; margin-bottom:8px; color:var(--danger);">Manage Account</h3>
            <div style="display:flex; gap:10px;">
                <button class="btn btn-outline btn-sm" onclick="handleLogout()">Sign Out</button>
            </div>
        </div>
    `;
}

window.handleSettingsProfileSave = async function(event) {
    event.preventDefault();
    const updated = {
        name: document.getElementById("set-name").value,
        username: state.currentUser.username,
        avatar: state.currentUser.avatar,
        city: document.getElementById("set-city").value,
        bio: document.getElementById("set-bio").value,
        interests: state.currentUser.interests,
        languages: state.currentUser.languages,
        dob: state.currentUser.dob,
        gender: state.currentUser.gender
    };

    try {
        const res = await apiFetch('/auth/profile', {
            method: 'POST',
            body: JSON.stringify(updated)
        });
        state.currentUser = res.user;
        showPopMessage("Profile updated!", "success");
        window.location.hash = "#profile";
    } catch(e) {}
};

window.toggleDarkModeSetting = function(checkbox) {
    state.darkMode = checkbox.checked;
    localStorage.setItem("melo_dark_mode", state.darkMode);
    document.body.classList.toggle("dark-mode", state.darkMode);
    showPopMessage(state.darkMode ? "Dark mode on" : "Light mode on", "success");
};

window.handleLogout = function() {
    handleLogoutSilent();
    showPopMessage("Logged out.", "info");
};

function handleLogoutSilent() {
    token = null;
    state.currentUser = null;
    localStorage.removeItem("melo_jwt_token");
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    window.location.hash = "#auth";
}

// ----------------------------------------------------
// SAFETY & MODAL DIALOGS
// ----------------------------------------------------

window.blockUser = async function(userId) {
    if (confirm("Block this user? You will no longer see their events.")) {
        try {
            await apiFetch('/safety/block', {
                method: 'POST',
                body: JSON.stringify({ targetUserId: userId })
            });
            showPopMessage("User blocked.", "success");
            closeModal();
            window.location.hash = "#home";
        } catch(e) {}
    }
};

window.submitReportMock = async function() {
    try {
        await apiFetch('/safety/report', {
            method: 'POST',
            body: JSON.stringify({
                reportedType: 'user',
                reportedId: 'opposing_user_id',
                reason: 'harassment',
                details: 'Report details verification'
            })
        });
        closeModal();
        showPopMessage("Report submitted to Trust & Safety team. Thank you!", "success");
    } catch(e) {}
};

// ----------------------------------------------------
// EXPLORE SCREEN HELPER RE-RENDERS
// ----------------------------------------------------

let activeFilters = {
    category: "",
    date: "",
    free: false,
    public: null,
    age18: false,
    smallGroup: false
};

function renderExploreCategoryFilters() {
    const list = ["All", "Birthday", "House Party", "Coffee Meetup", "Dinner", "Movie Night", "Gaming", "Book Club", "Sports", "Hiking", "Cycling", "Photography", "Music", "Cultural", "Startup Networking", "Volunteer"];
    const target = document.getElementById("explore-category-scroll");
    if (!target) return;

    list.forEach(catName => {
        const key = catName === "All" ? "" : catName;
        const isActive = activeFilters.category === key;
        const pill = document.createElement("span");
        pill.className = `filter-pill ${isActive ? 'active' : ''}`;
        pill.innerHTML = catName;
        pill.onclick = function() {
            activeFilters.category = key;
            document.querySelectorAll("#explore-category-scroll .filter-pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            renderExploreResults();
        };
        target.appendChild(pill);
    });
}

window.triggerExploreSearch = function() {
    state.searchQuery = document.getElementById("explore-search-input").value;
    renderExploreResults();
};

window.toggleDateFilter = function(dateKey) {
    activeFilters.date = activeFilters.date === dateKey ? "" : dateKey;
    renderExploreView(document.getElementById("view-container"));
};

window.toggleToggleFilter = function(key) {
    activeFilters[key] = !activeFilters[key];
    renderExploreView(document.getElementById("view-container"));
};

async function renderExploreResults() {
    const grid = document.getElementById("explore-results-grid");
    if (!grid) return;

    // Build URL query options
    const params = new URLSearchParams();
    if (state.searchQuery) params.append("search", state.searchQuery);
    if (activeFilters.category) params.append("category", activeFilters.category);
    if (activeFilters.date) params.append("date", activeFilters.date);
    if (activeFilters.public !== null) params.append("public", activeFilters.public);
    if (activeFilters.age18) params.append("age18", "true");
    if (activeFilters.smallGroup) params.append("smallGroup", "true");

    try {
        const list = await apiFetch(`/gatherings?${params.toString()}`);
        grid.innerHTML = "";

        if (list.length === 0) {
            grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:24px; color:var(--text-muted);">No events found matching filters.</div>`;
        } else {
            list.forEach(event => {
                grid.appendChild(createEventCardHTML(event));
            });
        }
        if (window.lucide) window.lucide.createIcons();
    } catch(e) {}
}

// Global modal handlers
window.openModal = function(htmlContent) {
    const overlay = document.getElementById("modal-overlay");
    const body = document.getElementById("modal-body");
    if (overlay && body) {
        body.innerHTML = htmlContent;
        overlay.classList.remove("hidden");
        if (window.lucide) window.lucide.createIcons();
    }
};

window.closeModal = function() {
    const overlay = document.getElementById("modal-overlay");
    if (overlay) overlay.classList.add("hidden");
};

// Toast Notifications popup
window.showPopMessage = function(message, type = "success") {
    let container = document.getElementById("toast-holder");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-holder";
        container.style.cssText = "position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 10000; display:flex; flex-direction:column; gap:8px; pointer-events:none; width:90%; max-width:360px;";
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    let bg = "var(--success-light)";
    let col = "var(--success)";
    if (type === "danger") { bg = "var(--danger-light)"; col = "var(--danger)"; }
    if (type === "info") { bg = "var(--primary-light)"; col = "var(--primary)"; }

    toast.style.cssText = `background-color:${bg}; color:${col}; padding: 12px 18px; border-radius: var(--radius-md); font-size:13px; font-weight:600; text-align:center; box-shadow: var(--shadow-lg); border:1px solid ${col}; opacity:0; transform:translateY(-10px); transition: all 0.3s ease; pointer-events:auto;`;
    toast.innerText = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    }, 10);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-10px)";
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

// Date formatter
function formatDateString(dateStr) {
    if (!dateStr) return "";
    try {
        const parts = dateStr.split("-");
        if (parts.length === 3) {
            const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            return date.toLocaleDateString("en-US", { weekday: 'short', month: 'short', day: 'numeric' });
        }
    } catch(e) {}
    return dateStr;
}

// Cover options helper
function renderCreateCoverOptions() {
    const list = [
        { name: "Dinner", url: "https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=500" },
        { name: "Coffee", url: "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=500" },
        { name: "Hike", url: "https://images.unsplash.com/photo-1551632879-25b2d2a01a18?w=500" },
        { name: "Party", url: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=500" },
        { name: "Movie", url: "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500" },
        { name: "Games", url: "https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=500" }
    ];
    const target = document.getElementById("create-cover-selector");
    if (!target) return;

    list.forEach((item, idx) => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "width: 100px; height: 65px; border-radius: var(--radius-sm); overflow:hidden; border:2px solid transparent; cursor:pointer; flex-shrink:0;";
        wrap.innerHTML = `<img src="${item.url}" alt="${item.name}" style="width:100%; height:100%; object-fit:cover;">`;
        wrap.onclick = function() {
            document.querySelectorAll("#create-cover-selector div").forEach(d => d.style.borderColor = "transparent");
            wrap.style.borderColor = "var(--primary)";
            document.getElementById("create-cover-val").value = item.url;
        };
        target.appendChild(wrap);

        if (idx === 0) wrap.click();
    });
}

// Other window helpers
window.toggleDashboardTab = function(tabName) {
    activeDashboardTab = tabName;
    renderDashboardView(document.getElementById("view-container"));
};

window.viewUserProfile = function(username) {
    window.location.hash = `#profile?user=${username}`;
};

window.startChatWithHost = function(userId) {
    window.location.hash = `#chat?with=${userId}`;
};

window.handleHomeSearch = function(event) {
    if (event.key === "Enter") {
        const query = event.target.value;
        state.searchQuery = query;
        window.location.hash = `#explore?search=${encodeURIComponent(query)}`;
    }
};

window.insertEmojiMock = function() {
    const input = document.getElementById("chat-message-input");
    if (input) {
        input.value += " 😊 ";
        input.focus();
    }
};

window.openSafetyOptions = function(userId) {
    openModal(`
        <h2 style="font-size:18px; font-weight:700; margin-bottom:12px;"><i data-lucide="shield-alert" style="color:var(--danger);"></i> Safety & Moderation</h2>
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:16px;">
            <button class="btn btn-outline btn-full btn-sm" onclick="blockUser('${userId}')">Block User</button>
            <button class="btn btn-danger btn-full btn-sm" onclick="submitReportMock()">Report User</button>
        </div>
    `);
};

window.openReportModal = function(type, id) {
    openModal(`
        <h2 style="font-size: 16px; font-weight:700; margin-bottom:12px;">Report ${type}</h2>
        <div class="form-group">
            <label class="form-label">Explain the issue</label>
            <textarea class="form-input" placeholder="Give detail..."></textarea>
        </div>
        <button class="btn btn-danger btn-full btn-sm" onclick="submitReportMock()">Submit Report</button>
    `);
};

window.openGoogleMapDirections = function(query) {
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, "_blank");
};

let activeDashboardTab = "hosting";

// Initialize
document.addEventListener("DOMContentLoaded", initApp);
if (document.readyState === "complete" || document.readyState === "interactive") {
    initApp();
}
