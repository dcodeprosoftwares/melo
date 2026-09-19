// Melo Application Engine - Frontend API Integration & WebSocket Connection

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      console.log('SW registered: ', registration);
    }).catch(registrationError => {
      console.log('SW registration failed: ', registrationError);
    });
  });
}

const IS_DEV = window.location.port.startsWith('517');
const API_BASE = IS_DEV ? 'http://localhost:3001/api' : (import.meta.env.VITE_API_URL || '/api');
const SOCKET_URL = IS_DEV ? 'http://localhost:3001' : (import.meta.env.VITE_SOCKET_URL || window.location.origin);
let socket = null;
let token = localStorage.getItem("melo_jwt_token") || null;

let currentCarouselIndex = 0;
window.navigateDetailsCarousel = function(direction, total) {
    currentCarouselIndex += direction;
    if (currentCarouselIndex < 0) currentCarouselIndex = total - 1;
    if (currentCarouselIndex >= total) currentCarouselIndex = 0;
    
    const track = document.getElementById("details-carousel-track");
    if (track) {
        track.style.transform = `translateX(-${(currentCarouselIndex * 100) / total}%)`;
    }
    
    for (let i = 0; i < total; i++) {
        const ind = document.getElementById(`indicator-${i}`);
        if (ind) {
            ind.style.background = i === currentCarouselIndex ? "var(--primary)" : "rgba(255,255,255,0.5)";
        }
    }
};

function isProfileComplete() {
    if (!state.currentUser) return false;
    return !!(state.currentUser.username && state.currentUser.city && state.currentUser.bio && state.currentUser.is_aadhar_verified == 1);
}

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

// High-speed client-side in-memory cache for API requests
const clientApiCache = new Map();
const CLIENT_CACHE_TTL_MS = 6000; // 6 seconds

export function clearClientApiCache() {
    clientApiCache.clear();
}

// Unified fetch wrapper with Authorization support & client caching
async function apiFetch(path, options = {}) {
    const isGet = !options.method || options.method.toUpperCase() === 'GET';
    const cacheKey = `${path}`;
    const now = Date.now();

    if (!isGet) {
        clientApiCache.clear();
    } else if (!options.noCache && clientApiCache.has(cacheKey)) {
        const entry = clientApiCache.get(cacheKey);
        if (now - entry.timestamp < CLIENT_CACHE_TTL_MS) {
            return entry.data;
        }
    }

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
        if (isGet) {
            clientApiCache.set(cacheKey, { timestamp: now, data });
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
                return; // hashchange event will trigger handleRouting
            }
        } catch (err) {
            // Token is invalid, wipe session
            handleLogoutSilent();
        }
    } else {
        window.location.hash = "#auth";
        return;
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
            if (!isProfileComplete()) {
                showPopMessage("Please complete your profile details before hosting a gathering.", "info");
                window.location.hash = "#onboarding";
                return;
            }
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

    // Always navigate directly to home screen
    window.location.hash = "#home";
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
                    <div class="avatar-upload-preview" onclick="openAvatarPickerModal()">
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

                <div class="form-group" style="background: var(--bg-surface-secondary); padding: 16px; border-radius: 12px; border: 1px solid var(--border-color); margin-bottom: 24px;">
                    <label class="form-label" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>Aadhaar Identity Verification <span style="color:var(--danger);">*</span></span>
                        <span id="aadhar-badge-status" style="padding: 4px 8px; font-size: 11px; font-weight: 600; border-radius: 6px; ${state.currentUser.is_aadhar_verified == 1 ? 'background: rgba(34, 197, 94, 0.1); color: rgb(34, 197, 94); border: 1px solid rgba(34, 197, 94, 0.2);' : 'background: rgba(239, 68, 68, 0.1); color: rgb(239, 68, 68); border: 1px solid rgba(239, 68, 68, 0.2);'}">
                            ${state.currentUser.is_aadhar_verified == 1 ? '✅ Verified' : '❌ Unverified'}
                        </span>
                    </label>
                    
                    <div id="aadhar-verification-widget" style="margin-top: 10px;">
                        ${state.currentUser.is_aadhar_verified == 1 ? `
                            <div style="font-size: 13.5px; color: var(--text-color); font-weight: 500;">
                                Aadhaar Number: <span style="font-family: monospace; letter-spacing: 1px;">XXXX XXXX ${state.currentUser.aadhar_number.slice(-4)}</span>
                            </div>
                        ` : `
                            <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">You must verify your Aadhaar card to join or host events. Your number will remain private and secure.</p>
                            <div style="display: flex; gap: 8px;">
                                <input type="text" class="form-input" id="aadhar-number-input" placeholder="XXXX XXXX XXXX" maxlength="14" style="font-family: monospace; letter-spacing: 1.5px; flex: 1;" oninput="formatAadharInput(this)">
                                <button type="button" class="btn btn-secondary" onclick="triggerAadharVerification()">Verify Aadhaar</button>
                            </div>
                        `}
                    </div>
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

let mediaStream = null;

window.openAvatarPickerModal = function() {
    stopWebcamStream();

    const modal = document.createElement("div");
    modal.id = "avatar-picker-modal";
    modal.style = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000;";
    modal.innerHTML = `
        <div class="container-card text-center" style="width: 340px; padding: 24px; border-radius: 16px; background: var(--bg-surface); box-shadow: var(--shadow-lg);">
            <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 20px;">Select Profile Picture</h3>
            
            <input type="file" id="avatar-file-selector" accept="image/*" style="display:none;" onchange="handleAvatarFileSelect(event)">
            
            <div id="avatar-picker-choices" style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="startWebcamCapture()">
                    <i data-lucide="camera" style="width:16px; height:16px;"></i> Take Photo (Camera)
                </button>
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="document.getElementById('avatar-file-selector').click()">
                    <i data-lucide="image" style="width:16px; height:16px;"></i> Choose from Gallery
                </button>
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="selectRandomAvatarPreset()">
                    <i data-lucide="sparkles" style="width:16px; height:16px;"></i> Random Preset Avatar
                </button>
                
                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 8px 0;">
                <button type="button" class="btn btn-outline btn-full" onclick="closeAvatarPickerModal()">Cancel</button>
            </div>

            <div id="webcam-capture-panel" style="display: none; flex-direction: column; align-items: center; gap: 12px; width: 100%;">
                <div style="width: 200px; height: 200px; overflow: hidden; border-radius: 50%; border: 4px solid var(--primary); background: #000; display: flex; justify-content: center; align-items: center; margin: 0 auto;">
                    <video id="webcam-video" autoplay playsinline style="height: 100%; width: 100%; object-fit: cover; transform: scaleX(-1);"></video>
                </div>
                <div style="display: flex; gap: 8px; width: 100%;">
                    <button type="button" class="btn btn-secondary btn-full" onclick="stopWebcamCapture()">Back</button>
                    <button type="button" class="btn btn-primary btn-full" onclick="captureAvatarSnapshot()">Capture</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    if (window.lucide) window.lucide.createIcons();
};

window.closeAvatarPickerModal = function() {
    stopWebcamStream();
    const modal = document.getElementById("avatar-picker-modal");
    if (modal) modal.remove();
};

function stopWebcamStream() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
}

window.startWebcamCapture = async function() {
    const choices = document.getElementById("avatar-picker-choices");
    const panel = document.getElementById("webcam-capture-panel");
    const video = document.getElementById("webcam-video");
    
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 300, height: 300, facingMode: 'user' }
        });
        
        choices.style.display = "none";
        panel.style.display = "flex";
        video.srcObject = mediaStream;
    } catch (err) {
        showPopMessage("Could not access camera. Grant permissions.", "error");
        console.error(err);
    }
};

window.stopWebcamCapture = function() {
    stopWebcamStream();
    const choices = document.getElementById("avatar-picker-choices");
    const panel = document.getElementById("webcam-capture-panel");
    
    if (choices && panel) {
        choices.style.display = "flex";
        panel.style.display = "none";
    }
};

window.captureAvatarSnapshot = function() {
    const video = document.getElementById("webcam-video");
    if (!video || !mediaStream) return;
    
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    
    ctx.translate(300, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, 300, 300);
    
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    
    document.getElementById("avatar-preview-img").src = dataUrl;
    document.getElementById("onboard-avatar-val").value = dataUrl;
    
    showPopMessage("Photo captured successfully!", "success");
    closeAvatarPickerModal();
};

window.handleAvatarFileSelect = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith("image/")) {
        showPopMessage("Please select an image file.", "error");
        return;
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        document.getElementById("avatar-preview-img").src = dataUrl;
        document.getElementById("onboard-avatar-val").value = dataUrl;
        
        showPopMessage("Image selected from gallery!", "success");
        closeAvatarPickerModal();
    };
    reader.readAsDataURL(file);
};

window.selectRandomAvatarPreset = function() {
    const randomAvatars = [
        "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150",
        "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150",
        "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150",
        "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150",
        "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150",
        "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150",
        "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150",
        "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150"
    ];
    const selected = randomAvatars[Math.floor(Math.random() * randomAvatars.length)];
    document.getElementById("avatar-preview-img").src = selected;
    document.getElementById("onboard-avatar-val").value = selected;
    
    showPopMessage("Random preset avatar selected!", "success");
    closeAvatarPickerModal();
};

window.formatAadharInput = function(input) {
    let val = input.value.replace(/\s+/g, '').replace(/[^0-9]/gi, '');
    let parts = [];
    for (let i = 0; i < val.length; i += 4) {
        parts.push(val.substr(i, 4));
    }
    input.value = parts.join(' ');
};

window.triggerAadharVerification = async function() {
    const numberInput = document.getElementById("aadhar-number-input");
    if (!numberInput) return;
    const rawNum = numberInput.value.replace(/\s+/g, '');
    if (rawNum.length !== 12) {
        showPopMessage("Please enter a valid 12-digit Aadhaar number.", "error");
        return;
    }
    
    try {
        const sendRes = await apiFetch('/auth/send-aadhar-otp', {
            method: 'POST',
            body: JSON.stringify({ aadharNumber: rawNum })
        });
        
        const modal = document.createElement("div");
        modal.id = "aadhar-otp-modal";
        modal.style = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000;";
        modal.innerHTML = `
            <div class="container-card text-center" style="width: 320px; padding: 24px; border-radius: 16px; background: var(--bg-surface); box-shadow: var(--shadow-lg);">
                <div style="width: 48px; height: 48px; background: rgba(var(--primary-rgb), 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px auto;">
                    <i data-lucide="shield-check" style="width: 24px; height: 24px; color: var(--primary);"></i>
                </div>
                <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">Aadhaar Verification OTP</h3>
                <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">We sent a 6-digit verification code to the mobile number registered with your Aadhaar.</p>
                ${sendRes.devOtp ? `
                <div style="font-size: 11.5px; font-weight: 700; background: var(--bg-surface-secondary); padding: 8px 12px; border-radius: 8px; margin-bottom: 18px; border: 1px dashed var(--primary); color: var(--primary);">
                    🔑 Sandbox OTP Code: <strong>${sendRes.devOtp}</strong>
                </div>
                ` : `
                <div style="font-size: 11.5px; font-weight: 700; background: rgba(34, 197, 94, 0.05); padding: 8px 12px; border-radius: 8px; margin-bottom: 18px; border: 1px solid rgba(34, 197, 94, 0.2); color: rgb(34, 197, 94); display:flex; align-items:center; justify-content:center; gap:6px;">
                    <i data-lucide="smartphone" style="width:14px; height:14px;"></i> Real OTP sent to registered phone!
                </div>
                `}
                
                <input type="text" id="aadhar-otp-input" class="form-input text-center" placeholder="123456" maxlength="6" style="font-size: 20px; font-weight: 600; letter-spacing: 4px; font-family: monospace; width: 160px; margin: 0 auto 16px auto; height: 48px;">
                
                <div style="display: flex; gap: 8px;">
                    <button type="button" class="btn btn-secondary btn-full" onclick="closeAadharOtpModal()">Cancel</button>
                    <button type="button" class="btn btn-primary btn-full" onclick="submitAadharOtp('${rawNum}')">Verify Code</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        if (window.lucide) window.lucide.createIcons();
    } catch(err) {
        showPopMessage(err.message || "Failed to send Aadhaar verification OTP.", "error");
    }
};

window.closeAadharOtpModal = function() {
    const modal = document.getElementById("aadhar-otp-modal");
    if (modal) modal.remove();
};

window.submitAadharOtp = async function(aadharNum) {
    const otpInput = document.getElementById("aadhar-otp-input");
    if (!otpInput) return;
    const otp = otpInput.value;
    if (otp.length !== 6) {
        showPopMessage("Please enter the 6-digit OTP code.", "error");
        return;
    }
    
    const modalContent = document.querySelector("#aadhar-otp-modal > div");
    modalContent.innerHTML = `
        <div style="border: 4px solid var(--border-color); border-top: 4px solid var(--primary); border-radius: 50%; width: 36px; height: 36px; animation: spin 1s linear infinite; margin: 20px auto;"></div>
        <h3 style="font-size: 16px; font-weight: 600; margin-top: 16px;">Verifying identity with UIDAI...</h3>
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">Authenticating Aadhaar biometric and phone records.</p>
    `;
    
    try {
        const res = await apiFetch('/auth/verify-aadhar', {
            method: 'POST',
            body: JSON.stringify({ aadharNumber: aadharNum, otp })
        });
        
        if (res.user) {
            state.currentUser = res.user;
            closeAadharOtpModal();
            showPopMessage("Aadhaar Verified Successfully!", "success");
            renderOnboardingView(document.getElementById("view-container"));
        } else {
            showPopMessage("Verification failed.", "error");
            closeAadharOtpModal();
        }
    } catch (err) {
        showPopMessage(err.message || "Verification failed. Please check the OTP.", "error");
        closeAadharOtpModal();
    }
};

window.handleOnboardingSubmit = async function(event) {
    event.preventDefault();
    if (!state.currentUser || state.currentUser.is_aadhar_verified != 1) {
        showPopMessage("Please complete Aadhaar Identity Verification first.", "error");
        return;
    }
    
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
        languages,
        coverPhoto: state.currentUser ? state.currentUser.cover_photo : null
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
    const userName = state.currentUser ? state.currentUser.name : 'there';
    
    container.innerHTML = `
        <div class="greeting-section">
            <h1 class="greeting-title">${greeting}, ${userName}!</h1>
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
            ${state.gatherings && state.gatherings.length > 0 ? '' : '<div class="skeleton skeleton-card" style="grid-column: 1/-1;"></div>'}
        </div>
    `;

    renderCategoriesScroller();

    const grid = document.getElementById("home-featured-grid");

    // Instant render if cached data exists (0ms response)
    if (state.gatherings && state.gatherings.length > 0 && grid) {
        grid.innerHTML = "";
        state.gatherings.slice(0, 3).forEach(event => {
            grid.appendChild(createEventCardHTML(event));
        });
        if (window.lucide) window.lucide.createIcons();
    }
    
    try {
        // Parallel fetch for gatherings and saved items
        const [list, savedList] = await Promise.all([
            apiFetch('/gatherings'),
            apiFetch('/saved')
        ]);
        
        state.gatherings = list;
        state.savedGatherings = savedList.map(g => g.id);

        const currentGrid = document.getElementById("home-featured-grid");
        if (currentGrid) {
            currentGrid.innerHTML = "";
            if (list.length === 0) {
                currentGrid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:24px; color:var(--text-muted);">No social gatherings today. Go host one!</div>`;
            } else {
                list.slice(0, 3).forEach(event => {
                    currentGrid.appendChild(createEventCardHTML(event));
                });
            }
            if (window.lucide) window.lucide.createIcons();
        }
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

    let coverSrc = 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=500';
    if (event.coverImage) {
        if (event.coverImage.startsWith("[")) {
            try {
                const parsedImgs = JSON.parse(event.coverImage);
                coverSrc = parsedImgs[0] || coverSrc;
            } catch(e) {}
        } else {
            coverSrc = event.coverImage;
        }
    }

    card.innerHTML = `
        <div class="card-img-wrapper">
            <img class="card-img" src="${coverSrc}" alt="${event.title}">
            <span class="badge-tag card-badge" style="top: 12px; left: 12px; background: rgba(0,0,0,0.65); color: #fff; font-weight: 600; border: 1px solid rgba(255,255,255,0.15);">
                ${event.fee || 'Free'}
            </span>
            <span class="badge-tag ${event.public ? 'badge-success' : 'badge-warning'} card-badge" style="bottom: 12px; top: auto; left: 12px;">
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
                ${event.distance ? `<span>•</span> <span><i data-lucide="navigation" style="width:12px; height:12px; display:inline; vertical-align:text-bottom;"></i> ${event.distance} km away</span>` : ''}
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
    if (!isProfileComplete()) {
        showPopMessage("Please complete your profile details before booking an event.", "info");
        window.location.hash = "#onboarding";
        return;
    }
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

        <div class="filters-bar" id="explore-pills-bar" style="border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 20px;">
            <span class="filter-pill ${activeFilters.nearMe ? 'active' : ''}" data-filter="nearMe" onclick="toggleNearMeFilter()">📍 Near Me</span>
            <span class="filter-pill ${activeFilters.date === 'today' ? 'active' : ''}" data-filter="today" onclick="toggleDateFilter('today')">Today</span>
            <span class="filter-pill ${activeFilters.date === 'tomorrow' ? 'active' : ''}" data-filter="tomorrow" onclick="toggleDateFilter('tomorrow')">Tomorrow</span>
            <span class="filter-pill ${activeFilters.date === 'weekend' ? 'active' : ''}" data-filter="weekend" onclick="toggleDateFilter('weekend')">Weekend</span>
            <span class="filter-pill ${activeFilters.free ? 'active' : ''}" data-filter="free" onclick="toggleToggleFilter('free')">Free Entry</span>
            <span class="filter-pill ${activeFilters.age18 ? 'active' : ''}" data-filter="age18" onclick="toggleToggleFilter('age18')">18+ Age</span>
            <span class="filter-pill ${activeFilters.smallGroup ? 'active' : ''}" data-filter="smallGroup" onclick="toggleToggleFilter('smallGroup')">Small Group (<10)</span>
        </div>

        <div id="near-me-range-container" style="display: ${activeFilters.nearMe ? 'flex' : 'none'}; align-items:center; gap:12px; margin-bottom:20px; background:var(--surface); padding:10px 16px; border-radius:12px; border:1px solid var(--border);">
            <label style="font-size:13px; font-weight:600; min-width:120px;">Within: <span id="near-me-range-val">${activeFilters.radiusKm}</span> km</label>
            <input type="range" id="near-me-range" min="1" max="100" value="${activeFilters.radiusKm}" oninput="document.getElementById('near-me-range-val').innerText=this.value" onchange="updateNearMeRange(this.value)" style="flex:1;">
        </div>


        <div class="grid-cards" id="explore-results-grid">
            ${state.gatherings && state.gatherings.length > 0 ? '' : '<div class="skeleton skeleton-card" style="grid-column: 1/-1;"></div>'}
        </div>
    `;

    renderExploreCategoryFilters();
    
    // Instant local rendering if state.gatherings is cached!
    if (state.gatherings && state.gatherings.length > 0) {
        renderFilteredGatheringsLocally();
    }
    
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

        currentCarouselIndex = 0;
        let images = [event.coverImage || 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=1200'];
        if (event.coverImage && event.coverImage.startsWith("[")) {
            try {
                images = JSON.parse(event.coverImage);
            } catch(e) {}
        }

        container.innerHTML = `
            <div class="details-cover" style="position: relative; overflow: hidden; background: #000;">
                <div id="details-carousel-track" style="display: flex; height: 100%; transition: transform 0.3s ease-in-out; width: ${images.length * 100}%;">
                    ${images.map(img => `
                        <div style="width: ${100 / images.length}%; height: 100%; flex-shrink: 0;">
                            <img class="details-cover-img" src="${img}" alt="${event.title}" style="width: 100%; height: 100%; object-fit: cover;">
                        </div>
                    `).join("")}
                </div>
                
                ${images.length > 1 ? `
                    <button onclick="navigateDetailsCarousel(-1, ${images.length})" style="position: absolute; left: 16px; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; border-radius: 50%; background: rgba(0,0,0,0.5); border: 0; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10;">
                        <i data-lucide="chevron-left" style="width: 20px; height: 20px;"></i>
                    </button>
                    <button onclick="navigateDetailsCarousel(1, ${images.length})" style="position: absolute; right: 16px; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; border-radius: 50%; background: rgba(0,0,0,0.5); border: 0; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10;">
                        <i data-lucide="chevron-right" style="width: 20px; height: 20px;"></i>
                    </button>
                    <div style="position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; z-index: 10;">
                        ${images.map((_, idx) => `
                            <div class="carousel-indicator" id="indicator-${idx}" style="width: 8px; height: 8px; border-radius: 50%; background: ${idx === 0 ? 'var(--primary)' : 'rgba(255,255,255,0.5)'}; transition: background 0.2s;"></div>
                        `).join("")}
                    </div>
                ` : ''}

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
                        
                        <div class="details-card-icon">
                            <div class="icon-box-primary"><i data-lucide="banknote" style="width:18px; height:18px;"></i></div>
                            <div class="details-text-box">
                                <h3>Entry Fee</h3>
                                <p style="font-weight: 600; color: var(--primary);">${event.fee || 'Free Entry'}</p>
                            </div>
                        </div>

                        <div class="map-placeholder" onclick="openGoogleMapDirections('${event.venue}, ${event.location}', \`${event.mapUrl || ''}\`)">
                            <img src="https://images.unsplash.com/photo-1524661135-423995f22d0b?w=400" alt="Map mockup">
                            <div class="map-overlay">
                                <span>Open Directions</span>
                                <i data-lucide="navigation" style="width:14px; height:14px;"></i>
                            </div>
                        </div>
                        
                        ${event.mapUrl ? `
                            <a href="${event.mapUrl}" target="_blank" class="btn btn-secondary btn-full btn-sm" style="display:flex; align-items:center; justify-content:center; gap:8px;">
                                <i data-lucide="map" style="width:14px; height:14px;"></i> Open Google Maps Location
                            </a>
                        ` : ''}
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
    if (!isProfileComplete()) {
        showPopMessage("Please complete your profile details before booking an event.", "info");
        window.location.hash = "#onboarding";
        return;
    }
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

window.createEventLat = null;
window.createEventLng = null;

async function useCurrentLocationForEvent() {
    const locInput = document.getElementById('create-location');
    if (!navigator.geolocation) {
        showPopMessage("Geolocation is not supported by your browser", "danger");
        return;
    }
    
    locInput.value = "Locating...";
    
    navigator.geolocation.getCurrentPosition(async (position) => {
        try {
            const { latitude, longitude } = position.coords;
            window.createEventLat = latitude;
            window.createEventLng = longitude;
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`);
            const data = await res.json();
            
            if (data && data.address) {
                const city = data.address.city || data.address.town || data.address.village || data.address.county || "";
                const state = data.address.state || "";
                const locString = [city, state].filter(Boolean).join(", ");
                locInput.value = locString || "Unknown Location";
            } else {
                locInput.value = "";
                showPopMessage("Could not determine city from coordinates", "danger");
            }
        } catch(e) {
            locInput.value = "";
            showPopMessage("Failed to fetch location data", "danger");
        }
    }, (error) => {
        locInput.value = "";
        showPopMessage("Location access denied or failed", "danger");
    });
}

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

                <div class="grid-cards" style="grid-template-columns: repeat(3, 1fr); gap:12px; margin: 0 0 20px 0;">
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Venue Name</label>
                        <input type="text" class="form-input" id="create-venue" placeholder="My apartment" required>
                    </div>
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label" style="display:flex; justify-content:space-between; align-items:center;">
                            City, State
                            <button type="button" class="btn btn-outline" style="padding:2px 8px; font-size:11px; height:auto; border-radius:12px;" onclick="useCurrentLocationForEvent()">📍 Current</button>
                        </label>
                        <input type="text" class="form-input" id="create-location" placeholder="San Francisco, CA" required>
                    </div>
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Entry Fee (Optional)</label>
                        <input type="text" class="form-input" id="create-fee" placeholder="Free" value="Free">
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-label">Google Maps URL (Optional)</label>
                    <input type="url" class="form-input" id="create-mapurl" placeholder="https://maps.app.goo.gl/... or https://google.com/maps/...">
                </div>

                <div class="form-group">
                    <label class="form-label" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>Event Photos (1 to 6 photos required) <span style="color:var(--danger);">*</span></span>
                        <span id="create-photo-count" style="font-size:12px; color:var(--text-muted);">0 / 6</span>
                    </label>
                    
                    <input type="file" id="event-file-selector" accept="image/*" style="display:none;" onchange="handleEventPhotoFileSelect(event)">
                    
                    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-top:10px;" id="event-photos-grid">
                        <div id="add-event-photo-btn" onclick="triggerEventPhotoPicker()" style="aspect-ratio: 1; border: 2px dashed var(--border-color); border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; gap: 6px; background: var(--bg-surface-secondary); transition: border-color 0.2s;">
                            <i data-lucide="plus-circle" style="width:24px; height:24px; color:var(--text-muted);"></i>
                            <span style="font-size: 11px; color: var(--text-muted); font-weight: 500;">Add Photo</span>
                        </div>
                    </div>
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

    state.eventPhotos = [];
}

window.handleCreateGatheringSubmit = async function(event) {
    event.preventDefault();
    if (state.eventPhotos.length < 1) {
        showPopMessage("Please upload at least 1 photo for your event.", "error");
        return;
    }

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
        coverImage: JSON.stringify(state.eventPhotos),
        mapUrl: document.getElementById("create-mapurl").value.trim() || null,
        fee: document.getElementById("create-fee").value.trim() || "Free",
        ageRestriction: document.getElementById("create-age").value,
        dressCode: document.getElementById("create-dress").value,
        itemsToBring: document.getElementById("create-items").value,
        rules: document.getElementById("create-rules").value,
        public: !document.getElementById("create-approval-required").checked,
        tags: document.getElementById("create-tags").value.split(",").map(t => t.trim()).filter(t => t.length > 0),
        lat: window.createEventLat || null,
        lng: window.createEventLng || null
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

                const guestAttendees = (event.attendees || []).filter(a => a.id !== state.currentUser.id);
                let attendeesHtml = `
                    <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border-color);">
                        <h4 style="font-size:12.5px; font-weight:700; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                            <i data-lucide="users" style="width:14.5px; height:14.5px; color:var(--primary);"></i> Approved Guests & Attendance
                        </h4>
                        ${guestAttendees.length === 0 ? `
                            <p style="font-size:11.5px; color:var(--text-muted); margin-left:8px;">No approved guests yet.</p>
                        ` : `
                            <div style="display:flex; flex-direction:column; gap:8px;">
                                ${guestAttendees.map(guest => {
                                    const att = guest.attendance || 'unmarked';
                                    return `
                                        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-surface-secondary); padding:8px 12px; border-radius:8px; border:1px solid var(--border-color);">
                                            <div style="display:flex; align-items:center; gap:8px;">
                                                <img src="${guest.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" style="width:26px; height:26px; border-radius:50%; object-fit:cover;">
                                                <span style="font-size:12.5px; font-weight:600; color:var(--text-primary);">${guest.name}</span>
                                            </div>
                                            <div style="display:flex; gap:4px; align-items:center;">
                                                <button class="btn btn-sm ${att === 'present' ? 'btn-success' : 'btn-outline'}" style="padding: 3px 8px; font-size:10px; border-radius:6px;" onclick="updateAttendanceStatus(${event.id}, '${guest.id}', 'present')">Present</button>
                                                <button class="btn btn-sm ${att === 'absent' ? 'btn-danger' : 'btn-outline'}" style="padding: 3px 8px; font-size:10px; border-radius:6px;" onclick="updateAttendanceStatus(${event.id}, '${guest.id}', 'absent')">Absent</button>
                                                ${att === 'present' ? `<button class="btn btn-sm btn-primary" style="padding: 3px 8px; font-size:10px; border-radius:6px;" onclick="openSubmitReviewModal(${event.id}, '${guest.id}', '${guest.name}')">Review Guest</button>` : ''}
                                            </div>
                                        </div>
                                    `;
                                }).join("")}
                            </div>
                        `}
                    </div>
                `;

                html += `
                    <div class="container-card" style="margin-bottom:20px; border-left:4px solid var(--primary);">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                            <div>
                                <span class="badge-tag ${event.status === 'completed' ? 'badge-success' : (event.status === 'cancelled' ? 'badge-danger' : 'badge-primary')}">${event.category}</span>
                                <h3 style="font-size:17px; font-weight:700; cursor:pointer; margin-top:4px;" onclick="window.location.hash = '#details?id=${event.id}'">${event.title}</h3>
                                <p style="font-size:12.5px; color:var(--text-muted);">${formatDateString(event.date)} at ${event.time} • ${event.venue}</p>
                            </div>
                            <div style="display:flex; gap:6px;">
                                ${event.status !== 'completed' && event.status !== 'cancelled' ? `<button class="btn btn-sm btn-secondary" onclick="markCompleted(${event.id})">Complete</button>` : ''}
                                ${event.status !== 'cancelled' ? `<button class="btn btn-sm btn-outline" style="color:var(--danger);" onclick="deleteHostedGathering(${event.id})">Cancel</button>` : ''}
                            </div>
                        </div>
                        ${reqHtml}
                        ${attendeesHtml}
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
                                    ${event.attendance === 'present' ? `<button class="btn btn-sm btn-primary" onclick="openSubmitReviewModal(${event.id}, '${event.hostId}', 'Host')">Review Host</button>` : ''}
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
    if (confirm("Cancel this gathering? It will remain on your profile history as cancelled.")) {
        try {
            await apiFetch(`/gatherings/${id}`, { method: 'DELETE' });
            showPopMessage("Cancelled event.", "info");
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

function parseFeeAmount(feeStr) {
    if (!feeStr) return 0;
    const cleaned = feeStr.replace(/[^0-9]/g, '');
    return cleaned ? parseInt(cleaned) : 0;
}

window.toggleProfileTab = function(activeTab) {
    const hostedBtn = document.getElementById("profile-tab-hosted-btn");
    const attendedBtn = document.getElementById("profile-tab-attended-btn");
    const hostedContent = document.getElementById("profile-portfolio-hosted-content");
    const attendedContent = document.getElementById("profile-portfolio-attended-content");
    
    if (activeTab === "hosted") {
        hostedBtn.className = "btn btn-sm btn-primary";
        attendedBtn.className = "btn btn-sm btn-secondary";
        hostedContent.style.display = "block";
        attendedContent.style.display = "none";
    } else {
        hostedBtn.className = "btn btn-sm btn-secondary";
        attendedBtn.className = "btn btn-sm btn-primary";
        hostedContent.style.display = "none";
        attendedContent.style.display = "block";
    }
};

function renderTimelineHTML(groups) {
    const { past, today, upcoming } = groups;
    
    function makeListHTML(list, emptyMsg) {
        if (list.length === 0) return `<p style="font-size:12.5px; color:var(--text-muted); margin-left:12px;">${emptyMsg}</p>`;
        
        return list.map(e => {
            let parsedCover = "https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=100";
            if (e.coverImage) {
                if (e.coverImage.startsWith("[")) {
                    try {
                        parsedCover = JSON.parse(e.coverImage)[0] || parsedCover;
                    } catch(err) {}
                } else {
                    parsedCover = e.coverImage;
                }
            }
            
            return `
                <div onclick="window.location.hash='#details?id=${e.id}'" style="display:flex; align-items:center; gap:12px; padding:10px; border-radius:8px; border:1px solid var(--border-color); cursor:pointer; background:var(--bg-surface-secondary); margin-bottom:8px; transition: all 0.2s;" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border-color)'">
                    <img src="${parsedCover}" style="width:50px; height:50px; object-fit:cover; border-radius:6px; border:1px solid var(--border-color);">
                    <div style="flex:1;">
                        <h4 style="font-size:13.5px; font-weight:600; margin-bottom:2px; color:var(--text-primary);">${e.title}</h4>
                        <span style="font-size:11px; color:var(--text-muted);">${formatDateString(e.date)} at ${e.time} • ${e.venue}</span>
                    </div>
                    <span style="font-size:11.5px; font-weight:600; color:var(--primary); padding: 4px 8px; border-radius:6px; background: rgba(var(--primary-rgb), 0.05);">${e.fee || 'Free'}</span>
                </div>
            `;
        }).join("");
    }
    
    return `
        <div style="margin-bottom:16px;">
            <h4 style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; display:flex; align-items:center; gap:6px;">
                <i data-lucide="play-circle" style="width:14px; height:14px; color:var(--success);"></i> Today's Gatherings (${today.length})
            </h4>
            ${makeListHTML(today, "No events scheduled for today.")}
        </div>
        
        <div style="margin-bottom:16px;">
            <h4 style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; display:flex; align-items:center; gap:6px;">
                <i data-lucide="calendar" style="width:14px; height:14px; color:var(--primary);"></i> Upcoming Events (${upcoming.length})
            </h4>
            ${makeListHTML(upcoming, "No upcoming events scheduled.")}
        </div>

        <div style="margin-bottom:16px;">
            <h4 style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; display:flex; align-items:center; gap:6px;">
                <i data-lucide="history" style="width:14px; height:14px; color:var(--text-muted);"></i> Past Events History (${past.length})
            </h4>
            ${makeListHTML(past, "No history of past events.")}
        </div>
    `;
}

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
    const isAadharVerified = user.is_aadhar_verified == 1;

    // Load portfolio events and reviews
    const portfolio = await apiFetch(`/users/id/${user.id}/portfolio`).catch(() => ({ hosted: [], attended: [] }));
    const reviews = await apiFetch(`/users/id/${user.id}/reviews`).catch(() => []);

    // Financial summaries
    let totalEarned = 0;
    let totalSpent = 0;

    portfolio.hosted.forEach(g => {
        const feeVal = parseFeeAmount(g.fee);
        const guestsCount = (g.attendees || []).filter(uid => uid !== user.id).length;
        totalEarned += feeVal * guestsCount;
    });

    portfolio.attended.forEach(g => {
        if (g.hostId !== user.id) {
            totalSpent += parseFeeAmount(g.fee);
        }
    });

    const totalReviewsCount = reviews.length;
    const avgRating = totalReviewsCount > 0 ? (reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviewsCount).toFixed(1) : null;

    // Attendance statistics
    let presentCount = 0;
    let absentCount = 0;
    portfolio.attended.forEach(g => {
        if (g.attendance === 'present') presentCount++;
        else if (g.attendance === 'absent') absentCount++;
    });
    const totalAttendanceMarked = presentCount + absentCount;
    const attendanceRate = totalAttendanceMarked > 0 ? Math.round((presentCount / totalAttendanceMarked) * 100) : 100;

    // Categorise by timeline dates
    const todayStr = new Date().toISOString().split('T')[0];
    function categorizeEvents(list) {
        const past = [];
        const today = [];
        const upcoming = [];
        
        list.forEach(e => {
            if (e.date < todayStr) past.push(e);
            else if (e.date === todayStr) today.push(e);
            else upcoming.push(e);
        });
        
        past.sort((a,b) => b.date.localeCompare(a.date));
        today.sort((a,b) => a.time.localeCompare(b.time));
        upcoming.sort((a,b) => a.date.localeCompare(b.date));
        return { past, today, upcoming };
    }

    const hostedGroups = categorizeEvents(portfolio.hosted);
    const attendedGroups = categorizeEvents(portfolio.attended);

    container.innerHTML = `
        <!-- Profile Header Banner -->
        <div class="profile-cover" style="position: relative; height: 180px; border-radius: 16px; background: ${user.cover_photo ? `url(${user.cover_photo}) center/cover no-repeat` : 'linear-gradient(135deg, var(--primary), var(--secondary))'}; box-shadow: var(--shadow-sm); overflow: visible;">
            ${isCurrentUser ? `
                <button type="button" class="btn btn-secondary btn-sm" onclick="triggerProfileCoverPicker()" style="position: absolute; top: 16px; right: 16px; display:flex; align-items:center; gap:6px; background: rgba(15, 23, 42, 0.6); color:#fff; border:0; backdrop-filter: blur(8px); border-radius: 8px; font-weight:600; padding: 6px 12px; z-index: 5;">
                    <i data-lucide="camera" style="width:14px; height:14px;"></i> Edit Cover
                </button>
            ` : ''}
            
            <div class="profile-avatar-container" style="position: absolute; bottom: -50px; left: 24px; width: 100px; height: 100px; border-radius: 50%; border: 4px solid var(--bg-surface); box-shadow: 0 4px 10px rgba(0,0,0,0.1); overflow: hidden; background: #fff; z-index: 6;">
                <img class="profile-avatar-img" src="${user.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}" alt="${user.name}" style="width: 100%; height: 100%; object-fit: cover;">
                ${isCurrentUser ? `
                    <div class="profile-edit-badge" onclick="triggerProfileAvatarPicker()" style="position: absolute; bottom: 4px; right: 4px; background: var(--primary); color:#fff; width: 24px; height: 24px; border-radius: 50%; display:flex; align-items:center; justify-content:center; border: 2px solid var(--bg-surface); cursor:pointer; font-size:11px; z-index:7;">
                        <i data-lucide="edit" style="width:12px; height:12px;"></i>
                    </div>
                ` : ''}
            </div>
        </div>

        <div style="margin-top: 60px; padding: 0 4px;">
            <!-- Profile Info Header Card -->
            <div class="container-card" style="padding: 24px; border-radius: 16px; box-shadow: var(--shadow-sm); margin-bottom: 20px; background: var(--bg-surface);">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px;">
                    <div>
                        <h1 style="font-size: 22px; font-weight: 800; color: var(--text-primary); display:flex; align-items:center; gap:8px;">
                            ${user.name} 
                            ${isAadharVerified ? `<span class="verification-badge" title="Aadhaar Verified"><i data-lucide="badge-check" style="width:20px; height:20px; color:var(--primary); fill:rgba(var(--primary-rgb), 0.1);"></i></span>` : ''}
                        </h1>
                        <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
                            <span style="font-size: 13.5px; color: var(--text-muted); font-weight: 500;">@${user.username}</span>
                            <span style="color: var(--border-color);">•</span>
                            <span style="font-size: 13px; color: var(--text-muted); display:flex; align-items:center; gap:4px;"><i data-lucide="map-pin" style="width:12px; height:12px;"></i> ${user.city || "San Francisco"}</span>
                        </div>
                        ${avgRating ? `
                            <div style="font-size: 12.5px; color: var(--primary); font-weight: 700; display: flex; align-items: center; gap: 4px; margin-top: 8px;">
                                <i data-lucide="star" style="width:14px; height:14px; fill:var(--primary);"></i> ${avgRating} / 5.0 (${totalReviewsCount} reviews)
                            </div>
                        ` : ''}
                    </div>

                    <div style="display:flex; gap:8px;">
                        ${isCurrentUser ? `
                            <button class="btn btn-secondary btn-sm" onclick="window.location.hash = '#onboarding'" style="display:flex; align-items:center; gap:6px;"><i data-lucide="user-cog" style="width:14px; height:14px;"></i> Edit Profile</button>
                            <button class="btn btn-secondary btn-sm" onclick="window.location.hash = '#settings'" style="display:flex; align-items:center; gap:6px;"><i data-lucide="settings" style="width:14px; height:14px;"></i> Settings</button>
                        ` : `
                            <button class="btn btn-primary btn-sm" onclick="startChatWithHost('${user.id}')" style="display:flex; align-items:center; gap:6px;"><i data-lucide="message-square" style="width:14px; height:14px;"></i> Message</button>
                            <button class="btn btn-outline btn-sm" onclick="openSafetyOptions('${user.id}')"><i data-lucide="shield" style="width:14px; height:14px;"></i> Block / Report</button>
                        `}
                    </div>
                </div>

                <div style="margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border-color);">
                    <p style="font-size: 14px; color: var(--text-secondary); line-height: 1.6; margin: 0;">${user.bio || "No biography added yet."}</p>
                </div>

                <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:16px;">
                    <span style="padding: 4px 8px; font-size: 11px; font-weight: 600; border-radius: 6px; display:inline-flex; align-items:center; gap:4px; ${isAadharVerified ? 'background: rgba(34, 197, 94, 0.08); color: rgb(34, 197, 94); border: 1px solid rgba(34, 197, 94, 0.15);' : 'background: rgba(239, 68, 68, 0.08); color: rgb(239, 68, 68); border: 1px solid rgba(239, 68, 68, 0.15);'}">
                        ${isAadharVerified ? '✅ Aadhaar Verified' : '❌ Aadhaar Unverified'}
                    </span>
                </div>
            </div>

            <!-- Profile Details Stats accent row for public visitors -->
            ${!isCurrentUser ? `
                <div class="container-card" style="padding: 20px; border-radius: 16px; box-shadow: var(--shadow-sm); margin-bottom: 20px; background: var(--bg-surface);">
                    <h3 style="font-size:14px; font-weight:700; margin-bottom:12px; color:var(--text-primary);">Event Statistics</h3>
                    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px;">
                        <div style="text-align:center; padding:8px; background:var(--bg-surface-secondary); border-radius:8px;">
                            <span style="font-size:18px; font-weight:700; color:var(--primary); display:block;">${portfolio.hosted.filter(e => e.status === 'active').length}</span>
                            <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Active</span>
                        </div>
                        <div style="text-align:center; padding:8px; background:var(--bg-surface-secondary); border-radius:8px;">
                            <span style="font-size:18px; font-weight:700; color:var(--success); display:block;">${portfolio.hosted.filter(e => e.status === 'completed').length}</span>
                            <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Completed</span>
                        </div>
                        <div style="text-align:center; padding:8px; background:var(--bg-surface-secondary); border-radius:8px;">
                            <span style="font-size:18px; font-weight:700; color:var(--danger); display:block;">${portfolio.hosted.filter(e => e.status === 'cancelled').length}</span>
                            <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Cancelled</span>
                        </div>
                        <div style="text-align:center; padding:8px; background:var(--bg-surface-secondary); border-radius:8px;">
                            <span style="font-size:18px; font-weight:700; color:var(--secondary); display:block;">${portfolio.attended.length}</span>
                            <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Attended</span>
                        </div>
                    </div>
                </div>
            ` : ''}

            <!-- Interests Card -->
            <div class="container-card" style="padding: 20px; border-radius: 16px; box-shadow: var(--shadow-sm); margin-bottom: 20px; background: var(--bg-surface);">
                <h3 style="font-size:14px; font-weight:700; margin-bottom:12px; color:var(--text-primary); display:flex; align-items:center; gap:6px;"><i data-lucide="tag" style="width:14px; height:14px; color:var(--primary);"></i> Interests & Hobbies</h3>
                <div class="interest-tag-container" style="display:flex; flex-wrap:wrap; gap:8px;">
                    ${user.interests.length === 0 ? '<span style="color:var(--text-muted); font-size:12.5px;">No interests selected.</span>' : ''}
                    ${user.interests.map(i => `<span class="interest-tag" style="background: rgba(var(--primary-rgb), 0.06); color: var(--primary); font-weight: 600; padding: 6px 12px; border-radius: 8px; font-size: 12.5px;">${i}</span>`).join("")}
                </div>
            </div>

            <!-- Financial Summary Card (Private Owner Only) -->
            ${isCurrentUser ? `
                <div class="container-card" style="padding: 20px; border-radius: 16px; box-shadow: var(--shadow-sm); margin-bottom: 20px; background: var(--bg-surface);">
                    <h3 style="font-size:14px; font-weight:700; margin-bottom:12px; color:var(--text-primary); display:flex; align-items:center; gap:6px;"><i data-lucide="wallet" style="width:14px; height:14px; color:var(--primary);"></i> Financial Contribution</h3>
                    <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:16px;">
                        <div class="container-card" style="padding:14px; display:flex; align-items:center; gap:12px; background: rgba(34, 197, 94, 0.05); border-color: rgba(34, 197, 94, 0.15);">
                            <div class="icon-box-primary" style="background: rgba(34, 197, 94, 0.10); color: rgb(34, 197, 94); border:0; width:36px; height:36px;"><i data-lucide="trending-up" style="width:18px; height:18px;"></i></div>
                            <div>
                                <span style="font-size:11.5px; color:var(--text-muted); display:block;">Total Earned</span>
                                <span style="font-size:16px; font-weight:700; color:rgb(34, 197, 94);">₹${totalEarned.toLocaleString()}</span>
                            </div>
                        </div>
                        <div class="container-card" style="padding:14px; display:flex; align-items:center; gap:12px; background: rgba(168, 85, 247, 0.05); border-color: rgba(168, 85, 247, 0.15);">
                            <div class="icon-box-primary" style="background: rgba(168, 85, 247, 0.10); color: rgb(168, 85, 247); border:0; width:36px; height:36px;"><i data-lucide="shopping-bag" style="width:18px; height:18px;"></i></div>
                            <div>
                                <span style="font-size:11.5px; color:var(--text-muted); display:block;">Total Spent</span>
                                <span style="font-size:16px; font-weight:700; color:rgb(168, 85, 247);">₹${totalSpent.toLocaleString()}</span>
                            </div>
                        </div>
                    </div>
                </div>
            ` : ''}

            <!-- Attendance Check-in Reputation Card -->
            <div class="container-card" style="padding: 20px; border-radius: 16px; box-shadow: var(--shadow-sm); margin-bottom: 20px; background: var(--bg-surface);">
                <h3 style="font-size:14px; font-weight:700; margin-bottom:12px; color:var(--text-primary); display:flex; align-items:center; gap:6px;"><i data-lucide="check-square" style="width:14px; height:14px; color:var(--success);"></i> Guest Attendance Record</h3>
                <div style="border-left:4px solid var(--success); padding-left:14px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <span style="font-size:13px; font-weight:600; color:var(--text-secondary);">Check-in Reliability Rate</span>
                        <span style="font-size:15px; font-weight:700; color:var(--success);">${attendanceRate}%</span>
                    </div>
                    <div style="background: var(--bg-surface-secondary); height:6px; border-radius:3px; overflow:hidden; margin-bottom:12px;">
                        <div style="background: var(--success); width: ${attendanceRate}%; height:100%; border-radius:3px;"></div>
                    </div>
                    <div style="display:flex; gap:16px; font-size:12.5px; color:var(--text-muted);">
                        <span>✅ Present: <strong>${presentCount}</strong></span>
                        <span>❌ Absent: <strong>${absentCount}</strong></span>
                    </div>
                </div>
            </div>

            <!-- Event Portfolios Card (Owner tabbed, Visitor stats counts) -->
            ${isCurrentUser ? `
                <div class="container-card" style="padding: 20px; border-radius: 16px; box-shadow: var(--shadow-sm); margin-bottom: 20px; background: var(--bg-surface);">
                    <h3 style="font-size:14px; font-weight:700; margin-bottom:12px; color:var(--text-primary); display:flex; align-items:center; gap:6px;"><i data-lucide="calendar" style="width:14px; height:14px; color:var(--primary);"></i> Your Event Schedules</h3>
                    
                    <div style="display:flex; gap:8px; border-bottom:1px solid var(--border-color); padding-bottom:8px; margin-bottom:16px;">
                        <button class="btn btn-sm btn-primary" id="profile-tab-hosted-btn" onclick="toggleProfileTab('hosted')" style="border-radius:6px; font-size:12px;">Hosted Gatherings (${portfolio.hosted.length})</button>
                        <button class="btn btn-sm btn-secondary" id="profile-tab-attended-btn" onclick="toggleProfileTab('attended')" style="border-radius:6px; font-size:12px;">Attended Events (${portfolio.attended.length})</button>
                    </div>
                    
                    <div id="profile-portfolio-hosted-content" style="display: block;">
                        ${renderTimelineHTML(hostedGroups)}
                    </div>

                    <div id="profile-portfolio-attended-content" style="display: none;">
                        ${renderTimelineHTML(attendedGroups)}
                    </div>
                </div>
            ` : ''}

            <!-- Feedback & Reviews Card -->
            <div class="container-card" style="padding: 20px; border-radius: 16px; box-shadow: var(--shadow-sm); margin-bottom: 20px; background: var(--bg-surface);">
                <h3 style="font-size:14px; font-weight:700; margin-bottom:12px; color:var(--text-primary); display:flex; align-items:center; gap:6px;"><i data-lucide="message-square" style="width:14px; height:14px; color:var(--primary);"></i> Reviews & Feedback</h3>
                <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
                    ${reviews.length === 0 ? `
                        <p style="font-size:12.5px; color:var(--text-muted); margin:0;">No reviews received yet.</p>
                    ` : reviews.map(r => {
                        let stars = "";
                        for (let i = 1; i <= 5; i++) {
                            stars += `<span style="color: ${i <= r.rating ? 'var(--primary)' : 'var(--border-color)'}; font-size:13px; margin-right:1px;">★</span>`;
                        }
                        return `
                            <div style="padding:14px; background:var(--bg-surface-secondary); border:1px solid var(--border-color); border-radius:12px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        <img src="${r.reviewer_avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" style="width:26px; height:26px; border-radius:50%; object-fit:cover;">
                                        <div>
                                            <span style="font-size:12.5px; font-weight:700; color:var(--text-primary); display:block;">${r.reviewer_name}</span>
                                            <span style="font-size:10px; color:var(--text-muted); display:block;">@${r.reviewer_username}</span>
                                        </div>
                                    </div>
                                    <div style="display:flex; flex-direction:column; align-items:flex-end;">
                                        <div>${stars}</div>
                                        <span style="font-size:9.5px; color:var(--text-muted); font-weight:500; margin-top:2px;">${formatDateString(r.created_at.split('T')[0])}</span>
                                    </div>
                                </div>
                                <p style="font-size:12.5px; color:var(--text-secondary); line-height:1.5; margin:6px 0; font-style:italic;">"${r.feedback}"</p>
                                <span style="font-size:10.5px; color:var(--text-muted); font-weight:500; display:block;">Event: <strong>${r.event_title}</strong></span>
                            </div>
                        `;
                    }).join("")}
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
    smallGroup: false,
    nearMe: false,
    radiusKm: 10,
    nearMeLat: null,
    nearMeLng: null
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
            renderFilteredGatheringsLocally();
            renderExploreResults();
        };
        target.appendChild(pill);
    });
}

function renderFilteredGatheringsLocally() {
    const grid = document.getElementById("explore-results-grid");
    if (!grid || !state.gatherings || state.gatherings.length === 0) return false;
    
    let list = state.gatherings;
    const q = (state.searchQuery || "").trim().toLowerCase();
    if (q) {
        list = list.filter(g => 
            (g.title && g.title.toLowerCase().includes(q)) || 
            (g.description && g.description.toLowerCase().includes(q)) || 
            (g.location && g.location.toLowerCase().includes(q))
        );
    }
    if (activeFilters.category) {
        list = list.filter(g => g.category && g.category.toLowerCase() === activeFilters.category.toLowerCase());
    }
    if (activeFilters.date) {
        const todayStr = "2026-08-07";
        const tmrwStr = "2026-08-08";
        if (activeFilters.date === "today") list = list.filter(g => g.date === todayStr);
        else if (activeFilters.date === "tomorrow") list = list.filter(g => g.date === tmrwStr);
        else if (activeFilters.date === "weekend") {
            list = list.filter(g => {
                const day = new Date(g.date).getDay();
                return day === 0 || day === 6;
            });
        }
    }
    if (activeFilters.free) {
        list = list.filter(g => (g.fee || '').toLowerCase() === 'free' || g.fee === '₹0' || g.fee === '$0');
    }
    if (activeFilters.age18) {
        list = list.filter(g => g.ageRestriction && (g.ageRestriction.includes("18+") || g.ageRestriction.includes("21+")));
    }
    if (activeFilters.smallGroup) {
        list = list.filter(g => g.maxAttendees <= 10);
    }
    if (activeFilters.nearMe && activeFilters.nearMeLat !== null) {
        list = list.filter(g => {
            if (g.lat == null || g.lng == null) return false;
            const dist = haversineDist(activeFilters.nearMeLat, activeFilters.nearMeLng, g.lat, g.lng);
            if (dist <= activeFilters.radiusKm) {
                g.distance = dist.toFixed(1);
                return true;
            }
            return false;
        });
        list.sort((a,b) => parseFloat(a.distance) - parseFloat(b.distance));
    }
    
    grid.innerHTML = "";
    if (list.length === 0) {
        grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:24px; color:var(--text-muted);">No events found matching filters.</div>`;
    } else {
        list.forEach(event => {
            grid.appendChild(createEventCardHTML(event));
        });
    }
    if (window.lucide) window.lucide.createIcons();
    return true;
}

let searchDebounceTimer = null;
window.triggerExploreSearch = function() {
    const input = document.getElementById("explore-search-input");
    if (input) state.searchQuery = input.value;
    renderFilteredGatheringsLocally();
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        renderExploreResults();
    }, 250);
};

window.toggleDateFilter = function(dateKey) {
    activeFilters.date = activeFilters.date === dateKey ? "" : dateKey;
    document.querySelectorAll('#explore-pills-bar .filter-pill').forEach(pill => {
        const f = pill.getAttribute('data-filter');
        if (f === 'today' || f === 'tomorrow' || f === 'weekend') {
            pill.classList.toggle('active', activeFilters.date === f);
        }
    });
    renderFilteredGatheringsLocally();
    renderExploreResults();
};

window.toggleToggleFilter = function(key) {
    activeFilters[key] = !activeFilters[key];
    const pill = document.querySelector(`#explore-pills-bar .filter-pill[data-filter="${key}"]`);
    if (pill) pill.classList.toggle('active', !!activeFilters[key]);
    renderFilteredGatheringsLocally();
    renderExploreResults();
};

window.toggleNearMeFilter = function() {
    if (!activeFilters.nearMe) {
        if (!navigator.geolocation) {
            showPopMessage("Geolocation is not supported by your browser", "danger");
            return;
        }
        showPopMessage("Locating...", "info");
        navigator.geolocation.getCurrentPosition((pos) => {
            activeFilters.nearMe = true;
            activeFilters.nearMeLat = pos.coords.latitude;
            activeFilters.nearMeLng = pos.coords.longitude;
            const pill = document.querySelector('.filter-pill[data-filter="nearMe"]');
            if(pill) pill.classList.add("active");
            const rangeCont = document.getElementById("near-me-range-container");
            if(rangeCont) rangeCont.style.display = "flex";
            renderFilteredGatheringsLocally();
            renderExploreResults();
        }, () => {
            showPopMessage("Could not get location", "danger");
        });
    } else {
        activeFilters.nearMe = false;
        activeFilters.nearMeLat = null;
        activeFilters.nearMeLng = null;
        const pill = document.querySelector('.filter-pill[data-filter="nearMe"]');
        if(pill) pill.classList.remove("active");
        const rangeCont = document.getElementById("near-me-range-container");
        if(rangeCont) rangeCont.style.display = "none";
        renderFilteredGatheringsLocally();
        renderExploreResults();
    }
};

window.updateNearMeRange = function(val) {
    activeFilters.radiusKm = parseInt(val);
    renderFilteredGatheringsLocally();
    renderExploreResults();
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
    if (activeFilters.nearMe && activeFilters.nearMeLat !== null) {
        params.append("nearMeLat", activeFilters.nearMeLat);
        params.append("nearMeLng", activeFilters.nearMeLng);
        params.append("radiusKm", activeFilters.radiusKm);
    }

    try {
        const list = await apiFetch(`/gatherings?${params.toString()}`);
        if (!state.searchQuery && !activeFilters.category && !activeFilters.date && activeFilters.public === null && !activeFilters.age18 && !activeFilters.smallGroup && !activeFilters.nearMe) {
            state.gatherings = list;
        }
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
// Event photos upload helpers
window.triggerEventPhotoPicker = function() {
    if (state.eventPhotos.length >= 6) {
        showPopMessage("You can upload a maximum of 6 photos.", "error");
        return;
    }
    
    stopWebcamStream();
    const modal = document.createElement("div");
    modal.id = "event-photo-picker-modal";
    modal.style = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000;";
    modal.innerHTML = `
        <div class="container-card text-center" style="width: 340px; padding: 24px; border-radius: 16px; background: var(--bg-surface); box-shadow: var(--shadow-lg);">
            <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 20px;">Upload Event Photo</h3>
            
            <div id="event-picker-choices" style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="startEventWebcamCapture()">
                    <i data-lucide="camera" style="width:16px; height:16px;"></i> Take Photo (Camera)
                </button>
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="document.getElementById('event-file-selector').click()">
                    <i data-lucide="image" style="width:16px; height:16px;"></i> Choose from Gallery
                </button>
                
                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 8px 0;">
                <button type="button" class="btn btn-outline btn-full" onclick="closeEventPhotoPickerModal()">Cancel</button>
            </div>

            <div id="event-webcam-capture-panel" style="display: none; flex-direction: column; align-items: center; gap: 12px; width: 100%;">
                <div style="width: 250px; height: 180px; overflow: hidden; border-radius: 12px; border: 3px solid var(--primary); background: #000; display: flex; justify-content: center; align-items: center; margin: 0 auto;">
                    <video id="event-webcam-video" autoplay playsinline style="height: 100%; width: 100%; object-fit: cover; transform: scaleX(-1);"></video>
                </div>
                <div style="display: flex; gap: 8px; width: 100%;">
                    <button type="button" class="btn btn-secondary btn-full" onclick="stopEventWebcamCapture()">Back</button>
                    <button type="button" class="btn btn-primary btn-full" onclick="captureEventPhotoSnapshot()">Capture</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (window.lucide) window.lucide.createIcons();
};

window.closeEventPhotoPickerModal = function() {
    stopWebcamStream();
    const modal = document.getElementById("event-photo-picker-modal");
    if (modal) modal.remove();
};

window.startEventWebcamCapture = async function() {
    const choices = document.getElementById("event-picker-choices");
    const panel = document.getElementById("event-webcam-capture-panel");
    const video = document.getElementById("event-webcam-video");
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'environment' }
        });
        choices.style.display = "none";
        panel.style.display = "flex";
        video.srcObject = mediaStream;
    } catch(err) {
        showPopMessage("Could not access camera. Grant permissions.", "error");
    }
};

window.stopEventWebcamCapture = function() {
    stopWebcamStream();
    const choices = document.getElementById("event-picker-choices");
    const panel = document.getElementById("event-webcam-capture-panel");
    if (choices && panel) {
        choices.style.display = "flex";
        panel.style.display = "none";
    }
};

window.captureEventPhotoSnapshot = function() {
    const video = document.getElementById("event-webcam-video");
    if (!video || !mediaStream) return;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    
    ctx.translate(640, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, 640, 480);
    
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    addEventPhotoToArray(dataUrl);
    closeEventPhotoPickerModal();
};

window.handleEventPhotoFileSelect = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
        showPopMessage("Please select an image file.", "error");
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        addEventPhotoToArray(e.target.result);
        closeEventPhotoPickerModal();
    };
    reader.readAsDataURL(file);
    event.target.value = "";
};

function addEventPhotoToArray(dataUrl) {
    if (state.eventPhotos.length >= 6) return;
    state.eventPhotos.push(dataUrl);
    renderEventPhotosGrid();
}

function renderEventPhotosGrid() {
    const grid = document.getElementById("event-photos-grid");
    if (!grid) return;
    
    const thumbnails = grid.querySelectorAll(".event-photo-thumbnail");
    thumbnails.forEach(el => el.remove());
    
    state.eventPhotos.forEach((imgSrc, idx) => {
        const thumb = document.createElement("div");
        thumb.className = "event-photo-thumbnail";
        thumb.style = "aspect-ratio: 1; border-radius: 12px; overflow: hidden; position: relative; border: 1px solid var(--border-color);";
        thumb.innerHTML = `
            <img src="${imgSrc}" style="width:100%; height:100%; object-fit:cover;">
            <div onclick="deleteEventPhoto(${idx})" style="position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border-radius: 50%; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff; transition: background 0.2s;">
                <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
            </div>
        `;
        grid.insertBefore(thumb, document.getElementById("add-event-photo-btn"));
    });
    
    const countLabel = document.getElementById("create-photo-count");
    if (countLabel) {
        countLabel.innerText = `${state.eventPhotos.length} / 6`;
    }
    
    const addBtn = document.getElementById("add-event-photo-btn");
    if (addBtn) {
        addBtn.style.display = state.eventPhotos.length >= 6 ? "none" : "flex";
    }
    
    if (window.lucide) window.lucide.createIcons();
}

window.deleteEventPhoto = function(idx) {
    state.eventPhotos.splice(idx, 1);
    renderEventPhotosGrid();
};

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

window.openGoogleMapDirections = function(query, mapUrl) {
    if (mapUrl && mapUrl.trim().startsWith("http")) {
        window.open(mapUrl.trim(), "_blank");
    } else {
        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, "_blank");
    }
};

window.triggerProfileCoverPicker = function() {
    stopWebcamStream();
    
    let selector = document.getElementById("profile-cover-file-selector");
    if (!selector) {
        selector = document.createElement("input");
        selector.type = "file";
        selector.id = "profile-cover-file-selector";
        selector.accept = "image/*";
        selector.style.display = "none";
        selector.onchange = handleProfileCoverFileSelect;
        document.body.appendChild(selector);
    }
    
    const modal = document.createElement("div");
    modal.id = "profile-cover-picker-modal";
    modal.style = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000;";
    modal.innerHTML = `
        <div class="container-card text-center" style="width: 340px; padding: 24px; border-radius: 16px; background: var(--bg-surface); box-shadow: var(--shadow-lg);">
            <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 20px;">Upload Cover Photo</h3>
            
            <div id="cover-picker-choices" style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="startCoverWebcamCapture()">
                    <i data-lucide="camera" style="width:16px; height:16px;"></i> Take Photo (Camera)
                </button>
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="document.getElementById('profile-cover-file-selector').click()">
                    <i data-lucide="image" style="width:16px; height:16px;"></i> Choose from Gallery
                </button>
                
                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 8px 0;">
                <button type="button" class="btn btn-outline btn-full" onclick="closeCoverPickerModal()">Cancel</button>
            </div>

            <div id="cover-webcam-capture-panel" style="display: none; flex-direction: column; align-items: center; gap: 12px; width: 100%;">
                <div style="width: 280px; height: 160px; overflow: hidden; border-radius: 12px; border: 3px solid var(--primary); background: #000; display: flex; justify-content: center; align-items: center; margin: 0 auto;">
                    <video id="cover-webcam-video" autoplay playsinline style="height: 100%; width: 100%; object-fit: cover; transform: scaleX(-1);"></video>
                </div>
                <div style="display: flex; gap: 8px; width: 100%;">
                    <button type="button" class="btn btn-secondary btn-full" onclick="stopCoverWebcamCapture()">Back</button>
                    <button type="button" class="btn btn-primary btn-full" onclick="captureCoverPhotoSnapshot()">Capture</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (window.lucide) window.lucide.createIcons();
};

window.closeCoverPickerModal = function() {
    stopWebcamStream();
    const modal = document.getElementById("profile-cover-picker-modal");
    if (modal) modal.remove();
};

window.startCoverWebcamCapture = async function() {
    const choices = document.getElementById("cover-picker-choices");
    const panel = document.getElementById("cover-webcam-capture-panel");
    const video = document.getElementById("cover-webcam-video");
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 360, facingMode: 'user' }
        });
        choices.style.display = "none";
        panel.style.display = "flex";
        video.srcObject = mediaStream;
    } catch(err) {
        showPopMessage("Could not access camera. Grant permissions.", "error");
    }
};

window.stopCoverWebcamCapture = function() {
    stopWebcamStream();
    const choices = document.getElementById("cover-picker-choices");
    const panel = document.getElementById("cover-webcam-capture-panel");
    if (choices && panel) {
        choices.style.display = "flex";
        panel.style.display = "none";
    }
};

window.captureCoverPhotoSnapshot = function() {
    const video = document.getElementById("cover-webcam-video");
    if (!video || !mediaStream) return;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    
    ctx.translate(640, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, 640, 360);
    
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    updateProfileCoverImage(dataUrl);
    closeCoverPickerModal();
};

window.handleProfileCoverFileSelect = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
        showPopMessage("Please select an image file.", "error");
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        updateProfileCoverImage(e.target.result);
        closeCoverPickerModal();
    };
    reader.readAsDataURL(file);
    event.target.value = "";
};

async function updateProfileCoverImage(dataUrl) {
    if (!state.currentUser) return;
    
    try {
        const interests = state.currentUser.interests || [];
        const languages = state.currentUser.languages || [];
        
        const profileBody = {
            name: state.currentUser.name,
            username: state.currentUser.username,
            avatar: state.currentUser.avatar,
            bio: state.currentUser.bio,
            city: state.currentUser.city,
            dob: state.currentUser.dob,
            gender: state.currentUser.gender,
            interests,
            languages,
            coverPhoto: dataUrl
        };
        
        const res = await apiFetch('/auth/profile', {
            method: 'POST',
            body: JSON.stringify(profileBody)
        });
        
        state.currentUser = res.user;
        showPopMessage("Profile cover updated successfully!", "success");
        
        renderProfileView(document.getElementById("view-container"));
    } catch(err) {
        showPopMessage("Failed to update cover photo.", "error");
    }
}

window.openShareGathering = async function(eventId) {
    try {
        const event = await apiFetch(`/gatherings/${eventId}`);
        const shareLink = `${window.location.origin}/#details?id=${eventId}`;
        const chats = await apiFetch('/chats').catch(() => []);
        
        const modal = document.createElement("div");
        modal.id = "share-gathering-modal";
        modal.style = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000;";
        modal.innerHTML = `
            <div class="container-card text-center" style="width: 360px; padding: 24px; border-radius: 16px; background: var(--bg-surface); box-shadow: var(--shadow-lg);">
                <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">Share Gathering</h3>
                <p style="color:var(--text-muted); font-size:12.5px; margin-bottom:20px;">Share "${event.title}" with friends.</p>
                
                <div class="form-group" style="text-align: left; margin-bottom: 20px;">
                    <label class="form-label">Copy Event Link</label>
                    <div style="display:flex; gap:8px;">
                        <input type="text" class="form-input" id="share-link-input" value="${shareLink}" readonly style="font-family: monospace; font-size: 12px; flex: 1;">
                        <button type="button" class="btn btn-primary" onclick="copyShareLinkToClipboard()" style="padding: 0 16px; display:flex; align-items:center; justify-content:center;">
                            <i data-lucide="copy" style="width:16px; height:16px;"></i>
                        </button>
                    </div>
                </div>
                
                ${chats.length > 0 ? `
                    <div class="form-group" style="text-align: left; margin-bottom: 20px;">
                        <label class="form-label">Send directly to Contact</label>
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            <select class="form-input" id="share-contact-select">
                                <option value="">Select a contact...</option>
                                ${chats.map(c => `
                                    <option value="${c.oppUser.id}">${c.oppUser.name} (@${c.oppUser.username})</option>
                                `).join("")}
                            </select>
                            <button type="button" class="btn btn-secondary btn-full" onclick="sendGatheringInChat(${eventId}, \`${event.title}\`)" style="display:flex; justify-content:center; align-items:center; gap:8px;">
                                <i data-lucide="send" style="width:14px; height:14px;"></i> Send in Chat
                            </button>
                        </div>
                    </div>
                ` : ''}

                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 16px 0;">
                <button type="button" class="btn btn-outline btn-full" onclick="closeShareGatheringModal()">Close</button>
            </div>
        </div>
        `;
        
        document.body.appendChild(modal);
        if (window.lucide) window.lucide.createIcons();
    } catch(err) {
        showPopMessage("Failed to load sharing details.", "error");
    }
};

window.closeShareGatheringModal = function() {
    const modal = document.getElementById("share-gathering-modal");
    if (modal) modal.remove();
};

window.copyShareLinkToClipboard = function() {
    const copyText = document.getElementById("share-link-input");
    if (!copyText) return;
    
    copyText.select();
    copyText.setSelectionRange(0, 99999);
    
    navigator.clipboard.writeText(copyText.value)
        .then(() => {
            showPopMessage("Link copied to clipboard!", "success");
        })
        .catch(() => {
            showPopMessage("Failed to copy link.", "error");
        });
};

window.sendGatheringInChat = async function(eventId, eventTitle) {
    const contactId = document.getElementById("share-contact-select").value;
    if (!contactId) {
        showPopMessage("Please select a contact to share with.", "error");
        return;
    }
    
    const shareLink = `${window.location.origin}/#details?id=${eventId}`;
    const textMsg = `Check out this social gathering: "${eventTitle}"\n${shareLink}`;
    
    try {
        await apiFetch('/messages', {
            method: 'POST',
            body: JSON.stringify({
                receiverId: contactId,
                text: textMsg
            })
        });
        
        if (socket && socket.connected) {
            socket.emit('sendMessage', {
                receiverId: contactId,
                text: textMsg
            });
        }
        
        showPopMessage("Gathering shared in DM successfully!", "success");
        closeShareGatheringModal();
    } catch(err) {
        showPopMessage("Failed to share gathering in DM.", "error");
    }
};

window.openSubmitReviewModal = function(gatheringId, revieweeId, name) {
    const modal = document.createElement("div");
    modal.id = "submit-review-modal";
    modal.style = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000;";
    modal.innerHTML = `
        <div class="container-card" style="width: 360px; padding: 24px; border-radius: 16px; background: var(--bg-surface); box-shadow: var(--shadow-lg);">
            <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 8px; text-align: center;">Leave a Review</h3>
            <p style="color:var(--text-muted); font-size:12.5px; margin-bottom:20px; text-align: center;">Rate and review your experience with ${name}.</p>
            
            <form onsubmit="submitReview(event, ${gatheringId}, '${revieweeId}')">
                <div class="form-group" style="text-align: center; margin-bottom: 20px;">
                    <label class="form-label" style="text-align: center; display:block;">Select Rating</label>
                    <div style="display:inline-flex; gap:8px; font-size:24px; justify-content:center; margin-top:6px;">
                        <input type="hidden" id="review-rating-value" value="5">
                        <span class="star-btn" data-star="1" onclick="setReviewRating(1)" style="cursor:pointer; color:var(--primary);">★</span>
                        <span class="star-btn" data-star="2" onclick="setReviewRating(2)" style="cursor:pointer; color:var(--primary);">★</span>
                        <span class="star-btn" data-star="3" onclick="setReviewRating(3)" style="cursor:pointer; color:var(--primary);">★</span>
                        <span class="star-btn" data-star="4" onclick="setReviewRating(4)" style="cursor:pointer; color:var(--primary);">★</span>
                        <span class="star-btn" data-star="5" onclick="setReviewRating(5)" style="cursor:pointer; color:var(--primary);">★</span>
                    </div>
                </div>
                
                <div class="form-group" style="margin-bottom: 20px;">
                    <label class="form-label">Written Feedback</label>
                    <textarea class="form-input" id="review-feedback" placeholder="Share your experience..." required style="min-height: 100px;"></textarea>
                </div>
                
                <div style="display:flex; gap:10px;">
                    <button type="button" class="btn btn-outline btn-full" onclick="closeSubmitReviewModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary btn-full">Submit</button>
                </div>
            </form>
        </div>
    `;
    
    document.body.appendChild(modal);
    setReviewRating(5);
};

window.closeSubmitReviewModal = function() {
    const modal = document.getElementById("submit-review-modal");
    if (modal) modal.remove();
};

window.setReviewRating = function(rating) {
    document.getElementById("review-rating-value").value = rating;
    const stars = document.querySelectorAll(".star-btn");
    stars.forEach((star, idx) => {
        if (idx < rating) {
            star.style.color = "var(--primary)";
        } else {
            star.style.color = "var(--border-color)";
        }
    });
};

window.submitReview = async function(event, gatheringId, revieweeId) {
    event.preventDefault();
    const rating = parseInt(document.getElementById("review-rating-value").value);
    const feedback = document.getElementById("review-feedback").value;
    
    try {
        await apiFetch('/reviews', {
            method: 'POST',
            body: JSON.stringify({
                gatheringId,
                revieweeId,
                rating,
                feedback
            })
        });
        
        showPopMessage("Review submitted successfully!", "success");
        closeSubmitReviewModal();
        renderDashboardContent();
    } catch(err) {
        showPopMessage("Failed to submit review.", "error");
    }
};

window.updateAttendanceStatus = async function(gatheringId, guestId, status) {
    try {
        await apiFetch(`/gatherings/${gatheringId}/attendees/${guestId}/attendance`, {
            method: 'POST',
            body: JSON.stringify({ attendance: status })
        });
        showPopMessage(`Attendance marked as ${status}!`, "success");
        renderDashboardContent();
    } catch(err) {
        showPopMessage("Failed to update attendance.", "error");
    }
};

window.triggerProfileAvatarPicker = function() {
    stopWebcamStream();
    
    let selector = document.getElementById("profile-avatar-file-selector");
    if (!selector) {
        selector = document.createElement("input");
        selector.type = "file";
        selector.id = "profile-avatar-file-selector";
        selector.accept = "image/*";
        selector.style.display = "none";
        selector.onchange = handleProfileAvatarFileSelect;
        document.body.appendChild(selector);
    }
    
    const modal = document.createElement("div");
    modal.id = "profile-avatar-picker-modal";
    modal.style = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000;";
    modal.innerHTML = `
        <div class="container-card text-center" style="width: 340px; padding: 24px; border-radius: 16px; background: var(--bg-surface); box-shadow: var(--shadow-lg);">
            <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 20px;">Upload Profile Photo</h3>
            
            <div id="avatar-picker-choices" style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="startAvatarWebcamCapture()">
                    <i data-lucide="camera" style="width:16px; height:16px;"></i> Take Photo (Camera)
                </button>
                <button type="button" class="btn btn-secondary btn-full" style="display:flex; justify-content:center; align-items:center; gap:8px;" onclick="document.getElementById('profile-avatar-file-selector').click()">
                    <i data-lucide="image" style="width:16px; height:16px;"></i> Choose from Gallery
                </button>
                
                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 8px 0;">
                <button type="button" class="btn btn-outline btn-full" onclick="closeAvatarPickerModal()">Cancel</button>
            </div>

            <div id="avatar-webcam-capture-panel" style="display: none; flex-direction: column; align-items: center; gap: 12px; width: 100%;">
                <div style="width: 200px; height: 200px; overflow: hidden; border-radius: 50%; border: 3px solid var(--primary); background: #000; display: flex; justify-content: center; align-items: center; margin: 0 auto;">
                    <video id="avatar-webcam-video" autoplay playsinline style="height: 100%; width: 100%; object-fit: cover; transform: scaleX(-1);"></video>
                </div>
                <div style="display: flex; gap: 8px; width: 100%;">
                    <button type="button" class="btn btn-secondary btn-full" onclick="stopAvatarWebcamCapture()">Back</button>
                    <button type="button" class="btn btn-primary btn-full" onclick="captureAvatarPhotoSnapshot()">Capture</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (window.lucide) window.lucide.createIcons();
};

window.closeAvatarPickerModal = function() {
    stopWebcamStream();
    const modal = document.getElementById("profile-avatar-picker-modal");
    if (modal) modal.remove();
};

window.startAvatarWebcamCapture = async function() {
    const choices = document.getElementById("avatar-picker-choices");
    const panel = document.getElementById("avatar-webcam-capture-panel");
    const video = document.getElementById("avatar-webcam-video");
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 400, height: 400, facingMode: 'user' }
        });
        choices.style.display = "none";
        panel.style.display = "flex";
        video.srcObject = mediaStream;
    } catch(err) {
        showPopMessage("Could not access camera. Grant permissions.", "error");
    }
};

window.stopAvatarWebcamCapture = function() {
    stopWebcamStream();
    const choices = document.getElementById("avatar-picker-choices");
    const panel = document.getElementById("avatar-webcam-capture-panel");
    if (choices && panel) {
        choices.style.display = "flex";
        panel.style.display = "none";
    }
};

window.captureAvatarPhotoSnapshot = function() {
    const video = document.getElementById("avatar-webcam-video");
    if (!video || !mediaStream) return;
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    
    ctx.translate(400, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, 400, 400);
    
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    updateProfileAvatarImage(dataUrl);
    closeAvatarPickerModal();
};

window.handleProfileAvatarFileSelect = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
        showPopMessage("Please select an image file.", "error");
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        updateProfileAvatarImage(e.target.result);
        closeAvatarPickerModal();
    };
    reader.readAsDataURL(file);
    event.target.value = "";
};

async function updateProfileAvatarImage(dataUrl) {
    if (!state.currentUser) return;
    
    try {
        const interests = state.currentUser.interests || [];
        const languages = state.currentUser.languages || [];
        
        const profileBody = {
            name: state.currentUser.name,
            username: state.currentUser.username,
            avatar: dataUrl,
            bio: state.currentUser.bio,
            city: state.currentUser.city,
            dob: state.currentUser.dob,
            gender: state.currentUser.gender,
            interests,
            languages,
            coverPhoto: state.currentUser.cover_photo
        };
        
        const res = await apiFetch('/auth/profile', {
            method: 'POST',
            body: JSON.stringify(profileBody)
        });
        
        state.currentUser = res.user;
        showPopMessage("Profile picture updated successfully!", "success");
        
        renderProfileView(document.getElementById("view-container"));
    } catch(err) {
        showPopMessage("Failed to update avatar photo.", "error");
    }
}

let activeDashboardTab = "hosting";

// Initialize
document.addEventListener("DOMContentLoaded", initApp);
if (document.readyState === "complete" || document.readyState === "interactive") {
    initApp();
}
