// ====== LOCAL DATA LAYER ======
// sb is provided by local-db.js (localStorage-based Supabase replacement)

let currentUserId = null;
let currentUserProfile = null;
let currentUserName = '';
let currentUserEmail = '';
let currentChatUser = '';
let replyTarget = null;
let forwardMsgData = null;
let typingTimeout = null;
let activeContextMenu = null;
let activeContextTarget = null;
let convContextTarget = null;
let messagesChannel = null;
let allProfilesCache = [];
let allProfilesPromise = null;

// ====== SANITIZATION ======
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function safeUrl(url) {
  if (!url) return 'x';
  if (url.startsWith('data:image/') || url.startsWith('https://') || url.startsWith('http://')) return url;
  return 'x';
}

// ====== AUTH ======
async function handleSignup() {
  const name = document.getElementById('signupName');
  const email = document.getElementById('signupEmail');
  const password = document.querySelector('#screen-signup input[type="password"]');
  const age = document.getElementById('signupAge');
  const gender = document.getElementById('signupGender');
  const terms = document.getElementById('terms');
  if (!name.value.trim()) { showToast('Please enter your name'); name.focus(); return; }
  if (!email.value.trim()) { showToast('Please enter your email'); email.focus(); return; }
  if (!password.value.trim()) { showToast('Please enter a password'); password.focus(); return; }
  if (!terms.checked) { showToast('Please agree to the terms & conditions'); return; }
  try {
    const { data, error } = await sb.auth.signUp({
      email: email.value.trim(),
      password: password.value,
    });
    if (error) throw error;
    if (!data.user) { showToast('Signup failed'); return; }
    const { error: profileError } = await sb.from('profiles').insert({
      id: data.user.id,
      email: email.value.trim(),
      name: name.value.trim(),
      age: age.value.trim() || null,
      gender: gender.value || null,
      allow_requests: true
    });
    if (profileError) throw profileError;
    await loginUser(data.user.id, email.value.trim());
  } catch (e) {
    if (e.message && e.message.toLowerCase().includes('already registered')) {
      showToast('Email already registered. Please sign in.');
    } else {
      showToast(e.message || 'Signup failed');
    }
  }
}

async function handleLogin() {
  const email = document.querySelector('#screen-login input[type="email"]');
  const password = document.querySelector('#screen-login input[type="password"]');
  if (!email.value.trim() || !password.value.trim()) {
    showToast('Please enter email and password');
    return;
  }
  try {
    const { data, error } = await sb.auth.signInWithPassword({
      email: email.value.trim(),
      password: password.value
    });
    if (error) throw error;
    await loginUser(data.user.id, email.value.trim());
  } catch (e) {
    showToast('Invalid email or password');
  }
}

async function handleLogout() {
  await sb.auth.signOut();
  if (messagesChannel) { messagesChannel.unsubscribe(); messagesChannel = null; }
  currentUserId = null;
  currentUserProfile = null;
  applyLanguage('English');
  document.getElementById('currentLanguage').textContent = 'English';
  document.querySelectorAll('.language-item').forEach(i => i.classList.toggle('active', i.querySelector('.language-name')?.textContent === 'English'));
  navigateTo('screen-welcome');
}

async function loginUser(userId, userEmail) {
  currentUserId = userId;
  if (userEmail) currentUserEmail = userEmail;
  const { data: profile } = await sb.from('profiles').select('*').eq('id', userId).single();
  if (!profile) {
    document.getElementById('appLoading').style.display = 'none';
    navigateTo('screen-complete-profile');
    return;
  }
  currentUserProfile = profile;
  currentUserName = profile.name || '';
  document.querySelector('.menu-name').textContent = profile.name || '';
  document.getElementById('profileDisplayName').textContent = profile.name || '';
  document.getElementById('displayNameValue').textContent = profile.name || '';
  document.getElementById('emailValue').textContent = profile.email || '';
  document.getElementById('profileDisplayEmail').textContent = profile.email || '-';
  document.getElementById('profileDisplayAge').textContent = profile.age || '-';
  document.getElementById('profileDisplayGender').textContent = profile.gender || '-';
  document.getElementById('profileDisplayRole').textContent = 'New user';
  document.getElementById('ageValue').textContent = profile.age || '-';
  document.getElementById('genderValue').textContent = profile.gender || '-';
  if (profile.avatar) { applyAvatar(profile.avatar); }
  applySavedStatus(profile.status);
  await loadAllData();
  subscribeMessages();
  registerCurrentSession();
  navigateTo('screen-conversations');
}

async function handleCompleteProfile() {
  const name = document.getElementById('completeProfileName').value.trim();
  const age = document.getElementById('completeProfileAge');
  const gender = document.getElementById('completeProfileGender');
  if (!name) { showToast('Please enter your name'); return; }
  try {
    const { error } = await sb.from('profiles').upsert({
      id: currentUserId, email: currentUserEmail || '', name: name, age: age.value.trim() || null, gender: gender.value || null, allow_requests: true
    }, { onConflict: 'id' });
    if (error) throw error;
    currentUserName = name;
    document.querySelector('.menu-name').textContent = name;
    document.getElementById('profileDisplayName').textContent = name;
    document.getElementById('displayNameValue').textContent = name;
    await loadAllData();
    subscribeMessages();
    registerCurrentSession();
    navigateTo('screen-conversations');
  } catch (e) {
    showToast('Failed to create profile: ' + e.message);
  }
}

// ====== DATA LAYER ======
async function loadAllData() {
  if (!currentUserId) return;
  try {
    const profiles = await getProfiles();
    const { data } = await sb
      .from('conversations')
      .select('*')
      .or(`user_id.eq.${currentUserId},other_user_id.eq.${currentUserId}`);
    window._conversations = (data || []).map(r => {
      const otherProfile = r.user_id === currentUserId
        ? profiles.find(p => p.id === r.other_user_id)
        : profiles.find(p => p.id === r.user_id);
      return {
        id: r.id,
        shared_id: r.shared_id,
        name: otherProfile?.name || 'Unknown',
        avatar: otherProfile?.avatar || '',
        pinned: r.pinned || false,
        muted: r.muted || false,
        unread: r.unread || 0,
        lastMsg: r.last_msg || '',
        lastTime: r.last_time || ''
      };
    });
  } catch (e) {
    window._conversations = [];
  }
}

function getConversations() { return window._conversations || []; }

async function ensureConversation(otherUserId, otherName) {
  // 1. Local cache lookup
  const existing = getConversations().find(c => {
    const p = allProfilesCache.find(x => x.name === c.name);
    return p && p.id === otherUserId;
  });
  if (existing && existing.shared_id) return existing;
  if (existing) {
    const { data } = await sb.from('conversations').select('shared_id').eq('id', existing.id).single();
    if (data?.shared_id) { existing.shared_id = data.shared_id; return existing; }
  }

  // 2. DB lookup — check BOTH orientations (single row per conversation)
  let { data: serverRows } = await sb.from('conversations')
    .select('*')
    .eq('user_id', currentUserId)
    .eq('other_user_id', otherUserId);
  if (!serverRows?.length) {
    const r = await sb.from('conversations')
      .select('*')
      .eq('user_id', otherUserId)
      .eq('other_user_id', currentUserId);
    serverRows = r.data;
  }
  if (serverRows?.[0]) {
    const s = serverRows[0];
    return { id: s.id, shared_id: s.shared_id, name: otherName, pinned: s.pinned || false, muted: s.muted || false, unread: s.unread || 0, lastMsg: s.last_msg || '', lastTime: s.last_time || '' };
  }

  // 3. Create new conversation row (one row, current user owns it)
  const sharedId = genId();
  const now = new Date().toISOString();
  const { data: myData } = await sb.from('conversations').insert({
    user_id: currentUserId,
    other_user_id: otherUserId,
    shared_id: sharedId,
    pinned: false,
    muted: false,
    unread: 0,
    last_msg: '',
    last_time: null,
    created_at: now
  }).select().single();

  return { id: myData.id, shared_id: sharedId, name: otherName, pinned: false, muted: false, unread: 0, lastMsg: '', lastTime: '' };
}

async function getMessages() {
  if (!currentUserId || !currentChatUser) { console.log('getMessages: no user/chat'); return []; }
  try {
    const conv = getConversations().find(c => c.name === currentChatUser);
    console.log('getMessages: conv lookup', currentChatUser, conv);
    if (!conv) { console.log('getMessages: no conv found'); return []; }
    console.log('getMessages: shared_id', conv.shared_id);
    const { data } = await sb
      .from('messages')
      .select('*')
      .eq('shared_id', conv.shared_id)
      .order('created_at', { ascending: true });
    console.log('getMessages: query result', data);
    return (data || []).map(r => ({
      id: r.id,
      text: r.text,
      fromMe: r.sender_id === currentUserId,
      time: formatTime(r.created_at),
      replyTo: r.reply_to ? r.reply_to : null,
      created: r.created_at
    }));
  } catch (e) {
    console.error('getMessages: error', e);
    return [];
  }
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !currentChatUser) return;

  if ((window._blockedUsers || []).includes(currentChatUser)) {
    showToast('You blocked ' + currentChatUser + '. Unblock to chat.');
    return;
  }
  if ((window._blockedBy || []).includes(currentChatUser)) {
    showToast(currentChatUser + ' has blocked you.');
    return;
  }

  const allUsers = await getProfiles();
  const target = allUsers.find(u => u.name === currentChatUser);
  if (!target) return;

  const conv = await ensureConversation(target.id, currentChatUser);
  console.log('sendMessage: conv', conv);
  const msgData = { text };
  if (replyTarget) msgData.reply_to = replyTarget;

  try {
    const insertRes = await sb.from('messages').insert({
      shared_id: conv.shared_id,
      sender_id: currentUserId,
      text: text,
      reply_to: msgData.reply_to || null,
      created_at: new Date().toISOString()
    });
    console.log('sendMessage: insert result', insertRes);
    if (insertRes.error) throw insertRes.error;
    const ts = new Date().toISOString();
    const updRes = await sb.from('conversations').update({
      last_msg: text,
      last_time: ts
    }).eq('shared_id', conv.shared_id);
    console.log('sendMessage: update result', updRes);
  } catch (e) {
    console.error('sendMessage: caught error', e);
  }

  input.value = '';
  document.getElementById('sendBtn').classList.remove('visible');
  cancelReply();
  if (sb.stopTyping) sb.stopTyping(currentChatUser, currentUserId);

  const msgs = await getMessages();
  console.log('sendMessage: messages loaded', msgs);
  renderChatMessages(msgs);
}

// ====== REALTIME (Supabase subscriptions) ======
function subscribeMessages() {
  if (sb.onMessage) {
    sb.onMessage(async (payload) => {
      const active = document.querySelector('.screen.active');
      if (!active) return;
      if (active.id === 'screen-chat') {
        const msgs = await getMessages();
        renderChatMessages(msgs);
      }
      if (active.id === 'screen-conversations') {
        await loadAllData();
        await renderConversations();
      }
      // Update unread badge on sidebar
      const unreadEl = document.getElementById('totalUnread');
      if (unreadEl) {
        const convs = getConversations();
        const total = convs.reduce((s, c) => s + (c.unread || 0), 0);
        unreadEl.textContent = total;
        unreadEl.style.display = total > 0 ? 'flex' : 'none';
      }
    });
  }
  if (sb.onConversation) {
    sb.onConversation(async () => {
      const active = document.querySelector('.screen.active');
      if (!active) return;
      await loadAllData();
      if (active.id === 'screen-chat' || active.id === 'screen-conversations') {
        await renderConversations();
      }
    });
  }
  if (sb.onRequest) {
    sb.onRequest(async () => {
      await loadPendingRequests();
      const active = document.querySelector('.screen.active');
      if (active) {
        if (active.id === 'screen-conversations') {
          await renderConversations();
          await renderPendingRequests();
        }
        if (active.id === 'screen-requests') {
          await renderRequestsScreen();
        }
      }
    });
  }
  if (sb.onOnlineUsers) {
    sb.onOnlineUsers(() => {
      const active = document.querySelector('.screen.active');
      if (!active) return;
      if (active.id === 'screen-chat' && currentChatUser) {
        const isBlkd = (window._blockedUsers || []).includes(currentChatUser);
        if (isBlkd) {
          document.querySelector('.chat-status').textContent = 'Blocked';
        } else if (isUserOnline(currentChatUser)) {
          const profile = allProfilesCache.find(x => x.name === currentChatUser);
          const label = profile?.status || 'Online';
          document.querySelector('.chat-status').textContent = label;
        } else {
          document.querySelector('.chat-status').textContent = 'Offline';
        }
        const dot = document.querySelector('.chat-avatar-wrapper .online-dot');
        if (dot) {
          dot.className = 'online-dot';
          if (isUserOnline(currentChatUser)) dot.classList.add(getUserStatusColor(currentChatUser));
        }
      }
      renderConversations();
    });
  }
  if (sb.onTyping) {
    sb.onTyping((payload) => {
      const el = document.getElementById('typingIndicator');
      if (!el || !currentChatUser) return;
      const otherId = getUserIdByName(currentChatUser);
      if (!otherId) return;
      const isFromOther = payload.userId === otherId && payload.conversationId === currentChatUser;
      el.classList.toggle('active', isFromOther && payload.typing);
    });
  }
  messagesChannel = { unsubscribe() { /* cleanup handled by local-db.js */ } };
}

// ====== NAVIGATION ======
function navigateTo(screenId) {
  const screens = document.querySelectorAll('.screen');
  screens.forEach(screen => screen.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) target.classList.add('active');
  localStorage.setItem('chadapp_last_screen', screenId);

  if (screenId === 'screen-conversations') renderConversations();
  if (screenId === 'screen-requests') renderRequestsScreen();
  if (screenId === 'screen-search') {
    invalidateProfilesCache();
    document.getElementById('searchInput').value = '';
    handleSearch();
  }

  const authDotIndex = { 'screen-signup': 0, 'screen-login': 1 };
  if (authDotIndex[screenId] !== undefined) {
    document.querySelectorAll('.page-dots').forEach(dots => {
      dots.querySelectorAll('.dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === authDotIndex[screenId]);
      });
    });
  }
}

// ====== PROFILES HELPERS ======
async function getProfiles() {
  if (allProfilesPromise) return allProfilesPromise;
  allProfilesPromise = (async () => {
    try {
      const { data } = await sb.from('profiles').select('*');
      allProfilesCache = data || [];
      return allProfilesCache;
    } catch (e) {
      return [];
    }
  })();
  const result = await allProfilesPromise;
  return result;
}

function invalidateProfilesCache() {
  allProfilesPromise = null;
}

function isUserOnline(userName) {
  if (!window._onlineUsers) return false;
  const profile = allProfilesCache.find(x => x.name === userName);
  if (!profile) return false;
  if (!window._onlineUsers.has(profile.id)) return false;
  // Invisible status = appear offline
  if (profile.status === 'Invisible') return false;
  return true;
}

function getUserStatusColor(userName) {
  if (!isUserOnline(userName)) return '';
  const profile = allProfilesCache.find(x => x.name === userName);
  const status = profile?.status || 'Online';
  const map = { Online: 'green', Away: 'yellow', Busy: 'red' };
  return map[status] || 'green';
}

function getUserIdByName(name) {
  const users = allProfilesCache;
  const u = users.find(x => x.name === name);
  return u ? u.id : '';
}

async function isUserDiscoverable(userId) {
  try {
    const { data } = await sb.from('profiles').select('allow_requests').eq('id', userId).single();
    return data ? data.allow_requests !== false : true;
  } catch (e) {
    return true;
  }
}

// ====== BLOCKED USERS ======
async function loadBlockedUsers() {
  if (!currentUserId) return;
  try {
    const [r1, r2] = await Promise.all([
      sb.from('blocked_users').select('*, blocked:blocked_id ( id, name, avatar )').eq('user_id', currentUserId),
      sb.from('blocked_users').select('*, blocker:user_id ( id, name )').eq('blocked_id', currentUserId)
    ]);
    window._blockedUsers = (r1.data || []).map(r => r.blocked?.name || '');
    window._blockedBy = (r2.data || []).map(r => r.blocker?.name || '');
  } catch (e) {
    console.error('loadBlockedUsers error:', e);
    window._blockedUsers = [];
    window._blockedBy = [];
  }
}

async function toggleBlockUser(btn) {
  const name = currentChatUser;
  console.log('toggleBlockUser:', { name, currentUserId });
  const blocked = window._blockedUsers || [];
  const idx = blocked.indexOf(name);
  const allUsers = await getProfiles();
  const target = allUsers.find(u => u.name === name);
  console.log('toggleBlockUser target:', target);
  if (!target) return;

  if (idx > -1) {
    blocked.splice(idx, 1);
    try {
      const r = await sb.from('blocked_users').delete().eq('user_id', currentUserId).eq('blocked_id', target.id);
      console.log('toggleBlockUser unblock result:', r);
    } catch (e) {
      console.error('toggleBlockUser unblock error:', e);
    }
    btn.innerHTML = '<i class="fas fa-ban"></i> Block';
    btn.classList.remove('blocked');
    showToast(name + ' has been unblocked');
  } else {
    blocked.push(name);
    try {
      const r = await sb.from('blocked_users').insert({ user_id: currentUserId, blocked_id: target.id });
      console.log('toggleBlockUser block insert result:', r);
    } catch (e) {
      console.error('toggleBlockUser insert error:', e);
    }
    btn.innerHTML = '<i class="fas fa-check"></i> Blocked';
    btn.classList.add('blocked');
    showToast(name + ' has been blocked');
  }
  window._blockedUsers = blocked;
  console.log('toggleBlockUser final blocked:', window._blockedUsers);
  renderConversations();
}

// ====== CHAT ======
async function openChat(name) {
  currentChatUser = name;
  await loadBlockedUsers();
  const isBlocked = (window._blockedUsers || []).includes(name);
  document.querySelector('.chat-username').textContent = name;

  const chatDot = document.querySelector('.chat-avatar-wrapper .online-dot');
  if (chatDot) {
    chatDot.className = 'online-dot';
    if (isUserOnline(name)) chatDot.classList.add(getUserStatusColor(name));
  }

  const chatInputBar = document.querySelector('.chat-input-bar');
  const chatStatus = document.querySelector('.chat-status');
  if (isBlocked) {
    chatStatus.textContent = 'Blocked';
    chatStatus.style.color = 'var(--text-muted)';
    chatInputBar.style.display = 'none';
  } else if (isUserOnline(name)) {
    const profile = allProfilesCache.find(x => x.name === name);
    const label = profile?.status || 'Online';
    chatStatus.textContent = label;
    chatStatus.style.color = '';
    chatInputBar.style.display = '';
  } else {
    chatStatus.textContent = 'Offline';
    chatStatus.style.color = '';
    chatInputBar.style.display = '';
  }

  const allUsers = await getProfiles();
  const u = allUsers.find(x => x.name === name);
  const chatAvatarImg = document.querySelector('.chat-avatar-wrapper img.chat-avatar');
  if (chatAvatarImg) {
    const wrapper = chatAvatarImg.parentNode;
    const fb = wrapper.querySelector('.avatar-fallback');
    if (fb) fb.remove();
    if (u && u.avatar) {
      chatAvatarImg.src = u.avatar;
      chatAvatarImg.style.display = '';
    } else {
      chatAvatarImg.src = 'x';
      chatAvatarImg.style.display = '';
      handleAvatarError(chatAvatarImg);
    }
  }
  document.querySelector('.chat-user').onclick = function() {
    viewUserProfile(name, u ? u.name : '');
  };

  const conv = getConversations().find(c => c.name === name);
  if (conv && conv.unread > 0) {
    try {
      await sb.from('conversations').update({ unread: 0 }).eq('id', conv.id);
    } catch (e) {}
  }

  document.querySelector('.chat-messages').innerHTML = '';
  navigateTo('screen-chat');
  const msgs = await getMessages();
  renderChatMessages(msgs);
  cancelReply();
}

function renderChatMessages(msgs) {
  const container = document.querySelector('.chat-messages');
  container.innerHTML = '';
  msgs.forEach(m => container.appendChild(renderMessageBubble(m)));
  container.scrollTop = container.scrollHeight;
}

function renderMessageBubble(msg) {
  const div = document.createElement('div');
  div.className = 'message ' + (msg.fromMe ? 'sent' : 'received');
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (msg.replyTo) {
    const r = document.createElement('div');
    r.className = 'bubble-reply';
    r.innerHTML = `<div class="bubble-reply-bar"></div><div class="bubble-reply-text"><span class="bubble-reply-name">${esc(msg.replyTo.name)}</span><span>${esc(msg.replyTo.text)}</span></div>`;
    bubble.appendChild(r);
  }

  const p = document.createElement('p');
  p.textContent = msg.text;
  bubble.appendChild(p);

  if (msg.fromMe) {
    const status = document.createElement('span');
    status.className = 'msg-status';
    const icon = document.createElement('i');
    icon.className = 'fas fa-check-double';
    status.appendChild(icon);
    bubble.appendChild(status);
  }
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = msg.time;
  bubble.appendChild(time);

  bubble.oncontextmenu = function(e) { e.preventDefault(); openContextMenu(this); };
  bubble.ondblclick = function() { toggleReactions(this); };

  div.appendChild(bubble);
  return div;
}

// ====== CONVERSATIONS LIST ======
async function renderConversations() {
  const container = document.getElementById('conversationsList');
  const convs = getConversations();
  const blocked = window._blockedUsers || [];
  await loadPendingRequests();
  await renderPendingRequests();

  const pinned = convs.filter(c => c.pinned);
  const normal = convs.filter(c => !c.pinned);
  const sorted = [...pinned, ...normal];

  let html = '';
  if (!sorted.length) {
    html = `<div class="empty-state"><i class="fas fa-comment-dots" style="font-size:56px;opacity:0.4;"></i><h3>No chats yet</h3><p>Tap Find to search for people on Chadapp</p></div>`;
    container.innerHTML = html;
    return;
  }

  html += sorted.map(c => {
    const isBlocked = blocked.includes(c.name);
    const online = isUserOnline(c.name);
    const nameEsc = esc(c.name);
    return `
    <div class="conversation-item ${c.pinned ? 'pinned' : ''}" onclick="openChat('${nameEsc}')" data-name="${nameEsc}" oncontextmenu="event.preventDefault();openConversationContextMenu(event,'${nameEsc}')" style="${isBlocked ? 'opacity:0.6;' : ''}">
      <div class="conversation-avatar">
        <img src="${safeUrl(c.avatar)}" onerror="handleAvatarError(this)" alt="avatar">
        ${online && !isBlocked ? '<span class="online-dot ' + getUserStatusColor(c.name) + '"></span>' : ''}
      </div>
      <div class="conversation-info">
        <div class="conversation-top">
          <span class="conversation-name">${nameEsc}${isBlocked ? ' <span style="font-size:10px;color:var(--text-muted);font-weight:400;">(Blocked)</span>' : ''}</span>
          <span class="conversation-time">${c.lastTime ? formatTime(c.lastTime) : ''}</span>
        </div>
        <div class="conversation-bottom">
          <span class="conversation-preview">${isBlocked ? 'User is blocked' : esc(c.lastMsg || '')}</span>
          ${c.muted ? '<i class="fas fa-volume-mute conversation-muted-icon"></i>' : ''}
          ${!isBlocked && c.unread > 0 ? `<span class="conversation-badge">${c.unread}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = html;
}

// ====== SEARCH ======
async function handleSearch() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const container = document.getElementById('searchResults');
  const allUsers = await getProfiles();
  const others = allUsers.filter(u => u.id !== currentUserId);
  const convNames = getConversations().map(c => c.name);

  const available = [];
  for (const u of others) {
    if (convNames.includes(u.name)) continue;
    const discoverable = await isUserDiscoverable(u.id);
    if (discoverable) available.push(u);
  }

  if (!query) {
    container.innerHTML = `
      <div class="search-category"><h4>People on Chadapp</h4></div>
      ${available.length ? available.map(u => renderDiscoverUser(u)).join('') :
        '<div class="empty-state" style="padding:30px 24px;"><i class="fas fa-users"></i><p>No other users on the platform</p></div>'}
    `;
    return;
  }

  const chatMatches = getConversations().filter(c => c.name.toLowerCase().includes(query));
  const platformMatches = available.filter(u => u.name.toLowerCase().includes(query));

  let html = '';
  if (chatMatches.length) {
    html += `<div class="search-category"><h4>Your Chats</h4></div>`;
    html += chatMatches.map(c => {
      const nameEsc = esc(c.name);
      return `
      <div class="search-user-item" onclick="openChat('${nameEsc}')">
        <div class="search-avatar-wrapper" style="position:relative;width:46px;height:46px;flex-shrink:0;">
          <img src="${safeUrl(c.avatar)}" onerror="handleAvatarError(this)" alt="avatar" style="width:46px;height:46px;border-radius:50%;background:var(--bg-input);">
        ${isUserOnline(c.name) ? '<span class="online-dot ' + getUserStatusColor(c.name) + '"></span>' : ''}
        </div>
        <div class="search-user-info">
          <span class="search-user-name">${nameEsc}</span>
          <span class="search-user-last">${esc(c.lastMsg || '')}</span>
        </div>
      </div>`;
    }).join('');
  }
  if (platformMatches.length) {
    html += `<div class="search-category"><h4>On Chadapp</h4></div>`;
    html += platformMatches.map(u => renderDiscoverUser(u)).join('');
  }
  if (!html) {
    html = `<div class="empty-state"><i class="fas fa-search"></i><h3>No results</h3><p>No users found matching "${query}"</p></div>`;
  }
  container.innerHTML = html;
}

function renderDiscoverUser(user) {
  const nameEsc = esc(user.name);
  const avatarUrl = user.avatar || '';
  const btnHtml = `<button class="search-req-btn" onclick="event.stopPropagation();sendChatRequest('${nameEsc}')"><i class="fas fa-user-plus"></i> Request</button>`;
  return `
    <div class="search-user-item">
      <div class="search-avatar-wrapper" style="position:relative;width:46px;height:46px;flex-shrink:0;">
        <img src="${safeUrl(avatarUrl)}" onerror="handleAvatarError(this)" alt="avatar" style="width:46px;height:46px;border-radius:50%;background:var(--bg-input);">
        ${isUserOnline(user.name) ? '<span class="online-dot ' + getUserStatusColor(user.name) + '"></span>' : ''}
      </div>
      <div class="search-user-info">
        <span class="search-user-name">${nameEsc}</span>
        <span class="search-user-last" style="color:var(--accent);">${isUserOnline(user.name) ? 'Online' : 'Offline'}</span>
      </div>
      ${btnHtml}
    </div>
  `;
}

async function sendChatRequest(name) {
  const allUsers = await getProfiles();
  const target = allUsers.find(u => u.name === name);
  if (!target) return;
  try {
    await sb.from('chat_requests').insert({
      from_user_id: currentUserId,
      to_user_id: target.id,
      created_at: new Date().toISOString()
    });
    showToast('Chat request sent to ' + name);
  } catch (e) {
    showToast(e?.message?.includes('duplicate') ? 'Request already sent' : 'Failed: ' + (e.message || e || 'unknown error'));
  }
  const activeSearch = document.querySelector('#screen-search.active');
  if (activeSearch) handleSearch();
}

let pendingRequests = [];

async function loadPendingRequests() {
  try {
    const result = await sb.from('chat_requests')
      .select(`*, from_user:from_user_id ( id, name, avatar )`)
      .eq('to_user_id', currentUserId);
    pendingRequests = result?.data || [];
  } catch (e) {
    console.error('loadPendingRequests error:', e);
    pendingRequests = [];
  }
  const badge = document.getElementById('requestsBadge');
  const bell = document.getElementById('requestsBell');
  if (badge) {
    if (pendingRequests.length > 0) {
      badge.textContent = pendingRequests.length;
      badge.style.display = 'flex';
      if (bell) bell.style.color = 'var(--accent)';
    } else {
      badge.style.display = 'none';
      if (bell) bell.style.color = '';
    }
  }
}

async function renderPendingRequests() {
  await loadPendingRequests();
  const container = document.getElementById('pendingRequests');
  if (!container) return;
  if (!pendingRequests.length) {
    container.innerHTML = '';
    return;
  }
  const badge = document.getElementById('requestsBadge');
  if (badge) badge.textContent = pendingRequests.length;
  container.innerHTML = '<div class="requests-header"><i class="fas fa-inbox"></i> Pending Requests <span class="requests-count">' + pendingRequests.length + '</span></div>' +
    pendingRequests.map(r => {
      const name = r.from_user?.name || 'Unknown';
      const nameEsc = esc(name);
      return `
      <div class="request-item">
        <div class="request-avatar">${esc(name.charAt(0).toUpperCase())}</div>
        <div class="request-info">
          <span class="request-name">${nameEsc}</span>
          <span class="request-text">Wants to chat with you</span>
        </div>
        <div class="request-actions">
          <button class="request-accept" onclick="acceptRequest('${esc(r.id)}','${nameEsc}')"><i class="fas fa-check"></i></button>
          <button class="request-decline" onclick="declineRequest('${esc(r.id)}')"><i class="fas fa-times"></i></button>
        </div>
      </div>`;
    }).join('');
}

function toggleRequests() {
  if (document.getElementById('screen-requests').classList.contains('active')) {
    navigateTo('screen-conversations');
  } else {
    navigateTo('screen-requests');
  }
}

async function renderRequestsScreen() {
  await loadPendingRequests();
  const container = document.getElementById('requestsList');
  if (!container) return;
  if (!pendingRequests.length) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox" style="font-size:56px;opacity:0.4;"></i><h3>No requests</h3><p>When someone sends you a chat request, it will appear here</p></div>';
    return;
  }
  container.innerHTML = pendingRequests.map(r => {
    const name = r.from_user?.name || 'Unknown';
    const nameEsc = esc(name);
    return `
    <div class="request-item">
      <div class="request-avatar">${esc(name.charAt(0).toUpperCase())}</div>
      <div class="request-info">
        <span class="request-name">${nameEsc}</span>
        <span class="request-text">Wants to chat with you</span>
      </div>
      <div class="request-actions">
        <button class="request-accept" onclick="acceptRequest('${esc(r.id)}','${nameEsc}')"><i class="fas fa-check"></i></button>
        <button class="request-decline" onclick="declineRequest('${esc(r.id)}')"><i class="fas fa-times"></i></button>
      </div>
    </div>`;
  }).join('');
}

async function acceptRequest(requestId, name) {
  try {
    invalidateProfilesCache();
    const allUsers = await getProfiles();
    const target = allUsers.find(u => u.name === name);
    if (!target) { showToast('User not found'); return; }
    await sb.from('chat_requests').delete().eq('id', requestId);
    console.log('acceptRequest: target found', target.id);
    const conv = await ensureConversation(target.id, name);
    console.log('acceptRequest: conversation', conv);
    if (!conv) { showToast('Failed to create conversation'); return; }
    try {
      const r1 = await sb.from('contacts').upsert({
        user_id: currentUserId,
        contact_id: target.id
      }, { onConflict: 'user_id,contact_id' });
      console.log('acceptRequest: contact 1', r1);
      const r2 = await sb.from('contacts').upsert({
        user_id: target.id,
        contact_id: currentUserId
      }, { onConflict: 'user_id,contact_id' });
      console.log('acceptRequest: contact 2', r2);
    } catch (ce) {
      console.log('acceptRequest: contact error', ce);
    }
    showToast('Request accepted');
    await loadAllData();
    navigateTo('screen-conversations');
  } catch (e) {
    console.error('acceptRequest: CATCH', e);
    showToast('Error: ' + (e.message || e || 'unknown'));
  }
}

async function declineRequest(requestId) {
  try {
    await sb.from('chat_requests').delete().eq('id', requestId);
    showToast('Request declined');
    await loadAllData();
    navigateTo('screen-conversations');
  } catch (e) {}
}

// ====== CHAT HEADER DROPDOWN ======
function toggleChatMenu() {
  const dd = document.getElementById('chatHeaderDropdown');
  dd.classList.toggle('active');
  const isBlocked = (window._blockedUsers || []).includes(currentChatUser);
  const item = document.getElementById('chatBlockDropdownItem');
  if (item) {
    item.innerHTML = isBlocked ? '<i class="fas fa-check"></i> Unblock' : '<i class="fas fa-ban"></i> Block';
  }
}

function searchInChat() {
  document.getElementById('chatHeaderDropdown').classList.remove('active');
  const container = document.querySelector('.chat-messages');
  const existing = document.getElementById('chatSearchBar');
  if (existing) { existing.remove(); return; }
  const bar = document.createElement('div');
  bar.id = 'chatSearchBar';
  bar.style.cssText = 'padding:10px 16px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center;';
  bar.innerHTML = `
    <i class="fas fa-search" style="color:var(--text-muted);font-size:13px;"></i>
    <input type="text" placeholder="Search messages..." id="chatSearchInput" style="flex:1;border:none;outline:none;background:transparent;font-size:13px;color:var(--text-primary);font-family:inherit;">
    <i class="fas fa-times" onclick="closeChatSearch(this)" style="color:var(--text-muted);cursor:pointer;font-size:14px;"></i>
  `;
  container.parentNode.insertBefore(bar, container);
  const input = bar.querySelector('input');
  input.addEventListener('input', async function() {
    const q = this.value.toLowerCase();
    if (!q) { const msgs = await getMessages(); renderChatMessages(msgs); return; }
    const msgs = await getMessages();
    const filtered = msgs.filter(m => m.text && m.text.toLowerCase().includes(q));
    document.querySelector('.chat-messages').innerHTML = '';
    filtered.forEach(m => document.querySelector('.chat-messages').appendChild(renderMessageBubble(m)));
  });
  input.focus();
}

async function clearChat() {
  document.getElementById('chatHeaderDropdown').classList.remove('active');
  if (!confirm('Clear all messages with ' + currentChatUser + '?')) return;
  const conv = getConversations().find(c => c.name === currentChatUser);
  if (conv?.shared_id) {
    try {
      await sb.from('messages').delete().eq('shared_id', conv.shared_id);
      await sb.from('conversations').update({
        last_msg: '', last_time: null, unread: 0
      }).eq('shared_id', conv.shared_id);
      document.querySelector('.chat-messages').innerHTML = '';
      showToast('Chat cleared');
    } catch (e) {
      showToast('Failed to clear chat');
    }
  }
}

function blockFromChat() {
  document.getElementById('chatHeaderDropdown').classList.remove('active');
  const btn = document.getElementById('blockUserBtn') || document.createElement('div');
  toggleBlockUser(btn);
}

document.addEventListener('click', function(e) {
  const dd = document.getElementById('chatHeaderDropdown');
  if (dd && dd.classList.contains('active') && !e.target.closest('.chat-header-actions') && !e.target.closest('.chat-header-dropdown')) {
    dd.classList.remove('active');
  }
});

// ====== TYPING ======
const chatInputEl = document.getElementById('chatInput');
chatInputEl.addEventListener('input', function() {
  document.getElementById('sendBtn').classList.toggle('visible', this.value.trim().length > 0);
  if (currentChatUser && currentUserId) {
    const targetId = getUserIdByName(currentChatUser);
    if (targetId && sb.startTyping) {
      sb.startTyping(currentChatUser, currentUserId);
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        if (sb.stopTyping) sb.stopTyping(currentChatUser, currentUserId);
      }, 2000);
    }
  }
});

chatInputEl.addEventListener('keypress', function(e) {
  if (e.key === 'Enter' && this.value.trim()) sendMessage();
});

// ====== REPLY ======
function replyToMessage() {
  const messageDiv = activeContextTarget;
  if (!messageDiv) return;
  const bubble = messageDiv.querySelector('.message-bubble');
  let text = 'Media';
  if (bubble && bubble.querySelector('p')) text = bubble.querySelector('p').textContent;
  const name = messageDiv.classList.contains('sent') ? 'You' : currentChatUser;
  replyTarget = { name, text };
  document.getElementById('replyPreviewName').textContent = 'Replying to ' + name;
  document.getElementById('replyPreviewText').textContent = text;
  document.getElementById('replyPreview').classList.add('active');
  document.getElementById('chatInput').focus();
  closeContextMenu();
}

function cancelReply() {
  replyTarget = null;
  document.getElementById('replyPreview').classList.remove('active');
}

// ====== MESSAGE CONTEXT MENU ======
function openContextMenu(element) {
  closeContextMenu();
  activeContextTarget = element.closest('.message');
  const menu = document.createElement('div');
  menu.className = 'message-context-menu active';
  menu.innerHTML = `
    <div class="context-menu-item" onclick="replyToMessage()"><i class="fas fa-reply"></i> Reply</div>
    <div class="context-menu-item" onclick="forwardMessage()"><i class="fas fa-share"></i> Forward</div>
    <div class="context-menu-item danger" onclick="deleteMessage()"><i class="fas fa-trash"></i> Delete</div>
  `;
  const rect = element.getBoundingClientRect();
  const container = document.querySelector('.phone-container').getBoundingClientRect();
  menu.style.bottom = (container.bottom - rect.top + 10) + 'px';
  menu.style.right = '16px';
  if (element.closest('.message.received')) {
    menu.style.left = '16px';
    menu.style.right = 'auto';
  }
  document.querySelector('.chat-messages').appendChild(menu);
  activeContextMenu = menu;
}

function closeContextMenu() {
  if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null; }
  activeContextTarget = null;
}

function forwardMessage() {
  if (!activeContextTarget) return;
  const bubble = activeContextTarget.querySelector('.message-bubble');
  let text = '';
  if (bubble && bubble.querySelector('p')) text = bubble.querySelector('p').textContent;
  forwardMsgData = text;
  closeContextMenu();
  openForwardModal();
}

async function openForwardModal() {
  const allUsers = await getProfiles();
  const list = document.getElementById('forwardContactsList');
  list.innerHTML = allUsers.filter(u => u.name !== currentUserName).map(u => {
    const nameEsc = esc(u.name);
    return `
    <label class="forward-contact-item">
      <input type="checkbox" value="${nameEsc}">
      <div class="forward-contact-avatar">${esc(u.name.charAt(0).toUpperCase())}</div>
      <span class="forward-contact-name">${nameEsc}</span>
    </label>`;
  }).join('');
  document.getElementById('forwardModal').classList.add('active');
  document.getElementById('forwardMessageInput').value = '';
  document.getElementById('forwardMessageInput').focus();
}

function closeForward() {
  document.getElementById('forwardModal').classList.remove('active');
}

async function sendForward() {
  const checked = document.querySelectorAll('#forwardContactsList input[type="checkbox"]:checked');
  if (!checked.length) { showToast('Select at least one contact'); return; }
  const note = document.getElementById('forwardMessageInput').value.trim();
  const allUsers = await getProfiles();

  for (const cb of checked) {
    const name = cb.value;
    const target = allUsers.find(u => u.name === name);
    if (!target) continue;
    const conv = await ensureConversation(target.id, name);
    const msgText = '📨 Forwarded: ' + forwardMsgData;
    const finalText = note ? msgText + '\n\n' + note : msgText;
    try {
      await sb.from('messages').insert({
        shared_id: conv.shared_id,
        sender_id: currentUserId,
        text: finalText,
        created_at: new Date().toISOString()
      });
      await sb.from('conversations').update({ last_msg: finalText, last_time: new Date().toISOString() }).eq('shared_id', conv.shared_id);
    } catch (e) {}
  }

  closeForward();
  showToast('Message forwarded to ' + checked.length + ' contact(s)');
}

async function deleteMessage() {
  if (!activeContextTarget) return;
  const msgs = await getMessages();
  const msgIndex = Array.from(document.querySelectorAll('.chat-messages .message')).indexOf(activeContextTarget);
  const msg = msgs[msgIndex];
  if (msg?.id) {
    try {
      await sb.from('messages').delete().eq('id', msg.id);
    } catch (e) {}
  }
  activeContextTarget.style.opacity = '0.3';
  activeContextTarget.style.transition = 'opacity 0.3s';
  setTimeout(() => activeContextTarget.remove(), 300);
  closeContextMenu();
}

document.addEventListener('click', function(e) {
  if (activeContextMenu && !e.target.closest('.message-context-menu') && !e.target.closest('.message-bubble')) closeContextMenu();
  if (!e.target.closest('.message-context-menu')) closeConversationContextMenu();
});

// ====== REACTIONS ======
function toggleReactions(element) {
  const existing = element.querySelector('.reaction-picker');
  if (existing && existing.classList.contains('active')) { existing.classList.remove('active'); return; }
  const picker = document.createElement('div');
  picker.className = 'reaction-picker active';
  const msgDiv = element.closest('.message');
  if (msgDiv && msgDiv.classList.contains('sent')) { picker.style.left = 'auto'; picker.style.right = '0'; }
  else { picker.style.left = '0'; picker.style.right = 'auto'; }
  ['❤️','😂','😮','😢','🙏','👍'].forEach(e => {
    const span = document.createElement('span');
    span.textContent = e;
    span.onclick = function(ev) { ev.stopPropagation(); addReaction(element, e); picker.remove(); };
    picker.appendChild(span);
  });
  element.appendChild(picker);
}

function addReaction(bubble, emoji) {
  let reactions = bubble.querySelector('.message-reactions');
  if (!reactions) {
    reactions = document.createElement('div');
    reactions.className = 'message-reactions';
    bubble.appendChild(reactions);
  }
  const existing = reactions.querySelector(`[data-emoji="${emoji}"]`);
  if (existing) { existing.remove(); return; }
  const span = document.createElement('span');
  span.className = 'reaction-emoji';
  span.setAttribute('data-emoji', emoji);
  span.textContent = emoji;
  span.onclick = () => span.remove();
  reactions.appendChild(span);
  closeContextMenu();
}

// ====== FAVORITES ======
async function toggleFavorite(name) {
  const conv = getConversations().find(c => c.name === name);
  if (!conv) return;
  const newFav = !conv.pinned;
  try { await sb.from('conversations').update({ pinned: newFav }).eq('id', conv.id); } catch (e) {}
  await loadAllData();
  renderFavorites();
  renderConversations();
  closeConversationContextMenu();
  showToast(newFav ? 'Added to favorites' : 'Removed from favorites');
}

function renderFavorites() {
  const container = document.getElementById('favoritesList');
  const favs = getConversations().filter(c => c.pinned);
  if (!favs.length) {
    container.innerHTML = `<div class="empty-state"><i class="fas fa-heart"></i><h3>No favorites yet</h3><p>Right-click a conversation to add it</p></div>`;
    return;
  }
  container.innerHTML = favs.map(c => {
    const nameEsc = esc(c.name);
    return `
    <div class="favorite-item" onclick="openChat('${nameEsc}')">
      <div class="fav-avatar-wrapper" style="position:relative;width:50px;height:50px;flex-shrink:0;">
        <img src="${safeUrl(c.avatar)}" onerror="handleAvatarError(this)" alt="avatar" style="width:50px;height:50px;border-radius:50%;background:var(--bg-input);">
        ${isUserOnline(c.name) ? '<span class="online-dot ' + getUserStatusColor(c.name) + '"></span>' : ''}
      </div>
      <div class="fav-info">
        <span class="fav-name">${nameEsc}</span>
        <span class="fav-status">${isUserOnline(c.name) ? 'Online' : 'Offline'}</span>
      </div>
      <div class="fav-heart active" onclick="event.stopPropagation(); toggleFavorite('${nameEsc}')">
        <i class="fas fa-heart"></i>
      </div>
    </div>`;
  }).join('');
}

// ====== CONVERSATION CONTEXT MENU ======
function openConversationContextMenu(e, name) {
  closeConversationContextMenu();
  convContextTarget = name;
  const conv = getConversations().find(c => c.name === name);
  const isPinned = conv && conv.pinned;
  const isMuted = conv && conv.muted;
  const existing = document.getElementById('convContextMenu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'convContextMenu';
  menu.className = 'message-context-menu active';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML = `
    <div class="context-menu-item" onclick="toggleFavorite('${name}')">
      <i class="fas fa-${isPinned ? 'heart-crack' : 'heart'}"></i> ${isPinned ? 'Remove from Favorites' : 'Add to Favorites'}
    </div>
    <div class="context-menu-item" onclick="togglePinConversation('${name}')">
      <i class="fas fa-${isPinned ? 'unpin' : 'thumbtack'}"></i> ${isPinned ? 'Unpin' : 'Pin'}
    </div>
    <div class="context-menu-item" onclick="toggleMuteConversation('${name}')">
      <i class="fas fa-${isMuted ? 'volume-up' : 'volume-mute'}"></i> ${isMuted ? 'Unmute' : 'Mute'}
    </div>`;
  document.body.appendChild(menu);
}

async function togglePinConversation(name) {
  const conv = getConversations().find(c => c.name === name);
  if (!conv) return;
  try { await sb.from('conversations').update({ pinned: !conv.pinned }).eq('id', conv.id); } catch (e) {}
  await loadAllData();
  renderConversations();
  closeConversationContextMenu();
}

async function toggleMuteConversation(name) {
  const conv = getConversations().find(c => c.name === name);
  if (!conv) return;
  try { await sb.from('conversations').update({ muted: !conv.muted }).eq('id', conv.id); } catch (e) {}
  await loadAllData();
  renderConversations();
  closeConversationContextMenu();
}

function closeConversationContextMenu() {
  const menu = document.getElementById('convContextMenu');
  if (menu) menu.remove();
  convContextTarget = null;
}

// ====== VIEW USER PROFILE ======
async function viewUserProfile(name) {
  document.getElementById('userProfileName').textContent = name;
  const profile = allProfilesCache.find(x => x.name === name);
  const statusLabel = isUserOnline(name) ? (profile?.status || 'Online') : 'Offline';
  document.getElementById('userProfileStatus').textContent = statusLabel;
  const img = document.getElementById('userProfileAvatar');
  const wrapper = img ? img.parentNode : null;
  if (wrapper) {
    const fb = wrapper.querySelector('.avatar-fallback');
    if (fb) fb.remove();
  }
  if (img) {
    if (profile && profile.avatar) {
      img.src = profile.avatar;
      img.style.display = '';
    } else {
      img.src = 'x';
      img.style.display = '';
      handleAvatarError(img);
    }
  }
  const fromScreen = document.querySelector('.screen.active');
  document.getElementById('userProfileBack').onclick = function() {
    navigateTo(fromScreen ? fromScreen.id : 'screen-conversations');
  };
  const blockBtn = document.getElementById('blockUserBtn');
  if (blockBtn) {
    const isBlocked = (window._blockedUsers || []).includes(name);
    blockBtn.innerHTML = isBlocked ? '<i class="fas fa-check"></i> Blocked' : '<i class="fas fa-ban"></i> Block';
    blockBtn.classList.toggle('blocked', isBlocked);
  }
  const msgs = await getMessages();
  document.getElementById('profileMessageCount').textContent = msgs.length;
  navigateTo('screen-user-profile');
}

function reportUser() {
  showToast('Thank you. ' + currentChatUser + ' has been reported.');
}

// ====== SETTINGS ======
function toggleTheme() {
  const toggle = document.getElementById('darkModeToggle');
  toggle.classList.toggle('active');
  document.body.classList.toggle('light-theme', !toggle.classList.contains('active'));
}

function toggleSwitch(item) {
  const toggle = item.querySelector('.toggle-switch');
  if (toggle) toggle.classList.toggle('active');
}

async function selectStatus(element) {
  document.querySelectorAll('.status-option').forEach(o => o.classList.remove('active'));
  element.classList.add('active');
  const status = element.querySelector('.status-dot').className.match(/(green|yellow|red|gray)/)?.[1];
  const statusMap = { green: 'Online', yellow: 'Away', red: 'Busy', gray: 'Invisible' };
  if (status && currentUserId) {
    try {
      await sb.from('profiles').update({ status: statusMap[status] }).eq('id', currentUserId);
      if (currentUserProfile) currentUserProfile.status = statusMap[status];
    } catch (e) {}
  }
  showToast('Status: ' + (statusMap[status] || 'Online'));
}

function applySavedStatus(status) {
  if (!status) return;
  const colors = { Online: 'green', Away: 'yellow', Busy: 'red', Invisible: 'gray' };
  const color = colors[status];
  if (!color) return;
  document.querySelectorAll('.status-option').forEach(o => {
    const dot = o.querySelector('.status-dot');
    if (dot && dot.classList.contains(color)) o.classList.add('active');
  });
}

function copyInviteLink() {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast('Invite link copied'))
    .catch(() => showToast('Could not copy link'));
}

function compressImage(file, maxSizeKB, cb) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const MAX_DIM = 256;
      let w = img.width, h = img.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let quality = 0.7, step = 0;
      const tryCompress = () => {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const sizeKB = Math.round((dataUrl.length * 3 / 4) / 1024);
        if (sizeKB <= maxSizeKB || quality <= 0.1 || step > 10) { cb(dataUrl); return; }
        quality = Math.max(0.1, quality - 0.1);
        step++;
        tryCompress();
      };
      tryCompress();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function changePhoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      compressImage(file, 20, function(compressed) {
        applyAvatar(compressed);
        if (currentUserId) {
          sb.from('profiles').update({ avatar: compressed }).eq('id', currentUserId).then(() => {});
        }
        showToast('Photo updated');
      });
    }
  };
  input.click();
}

function editField(field) {
  const labels = { displayName: 'Display Name', email: 'Email', age: 'Age', gender: 'Gender', role: 'Role' };
  const inputTypes = { displayName: 'text', email: 'email', age: 'number', gender: 'select', role: 'text' };
  document.getElementById('modalTitle').textContent = 'Edit ' + labels[field];
  const input = document.getElementById('modalInput');
  const select = document.getElementById('modalSelect');
  if (field === 'gender') {
    input.style.display = 'none';
    select.style.display = '';
    select.value = document.getElementById(field + 'Value').textContent;
  } else {
    input.style.display = '';
    select.style.display = 'none';
    input.type = inputTypes[field] || 'text';
    input.value = document.getElementById(field + 'Value').textContent;
    input.focus();
  }
  document.getElementById('editModal').classList.add('active');
  window._editField = field;
}

function closeModal() {
  document.getElementById('editModal').classList.remove('active');
}

async function saveModalField() {
  const field = window._editField;
  const input = document.getElementById('modalInput');
  const select = document.getElementById('modalSelect');
  const value = field === 'gender' ? select.value : input.value.trim();
  if (value && field && currentUserId) {
    document.getElementById(field + 'Value').textContent = value;
    try {
      const dbField = field === 'displayName' ? 'name' : field;
      await sb.from('profiles').update({ [dbField]: value }).eq('id', currentUserId);
    } catch (e) {
      // Silently fail — saveProfile() can be used to persist all fields
    }
    closeModal();
    showToast('Field updated');
  }
}

async function saveProfile() {
  if (!currentUserId) return;
  const name = document.getElementById('displayNameValue').textContent;
  const email = document.getElementById('emailValue').textContent;
  const age = document.getElementById('ageValue').textContent;
  const gender = document.getElementById('genderValue').textContent;
  try {
    await sb.from('profiles').update({ name, email, age, gender }).eq('id', currentUserId);
    currentUserName = name;
    document.querySelector('.menu-name').textContent = name;
    document.getElementById('profileDisplayName').textContent = name;
    document.getElementById('profileDisplayEmail').textContent = email;
    document.getElementById('profileDisplayAge').textContent = age;
    document.getElementById('profileDisplayGender').textContent = gender;
    invalidateProfilesCache();
    showToast('Profile saved');
  } catch (e) {
    showToast('Failed to save');
  }
}

async function changePassword() {
  const current = document.getElementById('currentPassword').value;
  const newPw = document.getElementById('newPassword').value;
  const confirm = document.getElementById('confirmPassword').value;
  if (!current || !newPw || !confirm) { showToast('Please fill all fields'); return; }
  if (newPw.length < 6) { showToast('Password must be at least 6 characters'); return; }
  if (newPw !== confirm) { showToast('Passwords do not match'); return; }
  try {
    const { error } = await sb.auth.updateUser({ password: newPw });
    if (error) throw error;
    showToast('Password updated successfully');
    ['currentPassword','newPassword','confirmPassword'].forEach(id => document.getElementById(id).value = '');
    navigateTo('screen-security');
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Please re-authenticate and try again'));
  }
}

document.addEventListener('input', function(e) {
  if (e.target && e.target.id === 'newPassword') {
    const val = e.target.value;
    const fill = document.getElementById('strengthFill');
    const text = document.getElementById('strengthText');
    let score = 0;
    if (val.length >= 6) score++;
    if (val.length >= 10) score++;
    if (/[A-Z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;
    const pct = (score / 5) * 100;
    fill.style.width = pct + '%';
    fill.style.background = score <= 2 ? '#e74c3c' : score <= 3 ? '#f39c12' : '#2ecc71';
    text.textContent = score <= 2 ? 'Weak' : score <= 3 ? 'Medium' : 'Strong';
  }
});

async function deleteAccount() {
  const reason = document.getElementById('deleteReason').value;
  const password = document.getElementById('deletePassword').value;
  const confirm = document.getElementById('confirmDelete');
  if (!reason) { showToast('Please select a reason'); return; }
  if (!password) { showToast('Please enter your password'); return; }
  if (!confirm.checked) { showToast('Please confirm you understand this is permanent'); return; }
  try {
    // Delete user data first
    if (currentUserId) {
      await sb.from('messages').delete().eq('sender_id', currentUserId);
      await sb.from('conversations').delete().eq('user_id', currentUserId);
      await sb.from('chat_requests').delete().eq('from_user_id', currentUserId);
      await sb.from('chat_requests').delete().eq('to_user_id', currentUserId);
      await sb.from('blocked_users').delete().eq('user_id', currentUserId);
      await sb.from('contacts').delete().eq('user_id', currentUserId);
      await sb.from('profiles').delete().eq('id', currentUserId);
    }
    // Sign out
    await sb.auth.signOut();
    showToast('Account deleted.');
    currentUserId = null;
    currentUserProfile = null;
    setTimeout(() => navigateTo('screen-welcome'), 500);
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Please contact support'));
  }
}

// ====== ACTIVE SESSIONS (cross-tab device tracking) ======
function getDeviceInfo() {
  const ua = navigator.userAgent;
  let platform = 'Unknown';
  let icon = 'fa-laptop';
  if (/windows/i.test(ua)) { platform = 'Windows'; icon = 'fa-laptop'; }
  else if (/macintosh|mac os x/i.test(ua)) { platform = 'macOS'; icon = 'fa-laptop'; }
  else if (/linux/i.test(ua) && !/android/i.test(ua)) { platform = 'Linux'; icon = 'fa-laptop'; }
  else if (/iphone/i.test(ua)) { platform = 'iOS'; icon = 'fa-mobile-alt'; }
  else if (/ipad/i.test(ua)) { platform = 'iOS'; icon = 'fa-tablet-alt'; }
  else if (/android/i.test(ua)) { platform = 'Android'; icon = /mobile/i.test(ua) ? 'fa-mobile-alt' : 'fa-tablet-alt'; }
  return { platform, icon };
}

function getActiveSessions() {
  if (!currentUserId) return [];
  const key = 'chadapp_sessions_' + currentUserId;
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : [];
}

function saveActiveSessions(sessions) {
  if (!currentUserId) return;
  const key = 'chadapp_sessions_' + currentUserId;
  localStorage.setItem(key, JSON.stringify(sessions));
  localStorage.setItem('chadapp_sessions_ts_' + currentUserId, Date.now().toString());
}

function registerCurrentSession() {
  const sessionId = 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  localStorage.setItem('chadapp_my_session', sessionId);
  const info = getDeviceInfo();
  const sessions = getActiveSessions().filter(s => s.id !== sessionId);
  sessions.push({ id: sessionId, platform: info.platform, icon: info.icon, lastActive: Date.now() });
  saveActiveSessions(sessions);
  // Presence is handled automatically by Supabase via local-db.js
}

function unregisterCurrentSession() {
  const sessionId = localStorage.getItem('chadapp_my_session');
  if (!sessionId || !currentUserId) return;
  const sessions = getActiveSessions().filter(s => s.id !== sessionId);
  saveActiveSessions(sessions);
  if (sb.sessions) sb.sessions.unregister(currentUserId);
}

function renderActiveDevices() {
  const container = document.getElementById('activeDevicesList');
  const countEl = document.getElementById('activeDevicesCount');
  const sessionId = localStorage.getItem('chadapp_my_session');
  const sessions = getActiveSessions();
  if (countEl) countEl.textContent = sessions.length + ' device' + (sessions.length !== 1 ? 's' : '');
  if (!sessions.length) {
    container.innerHTML = `<div class="empty-state"><i class="fas fa-wifi"></i><h3>No active sessions</h3></div>`;
    return;
  }
  container.innerHTML = sessions.map(s => {
    const isCurrent = s.id === sessionId;
    const timeAgo = isCurrent ? 'Current session' : formatTimeAgo(s.lastActive);
    const name = s.platform || s.deviceName || 'Unknown';
    return `
      <div class="device-item ${isCurrent ? 'current' : ''}">
        <div class="device-icon"><i class="fas ${s.icon}"></i></div>
        <div class="device-info">
          <span class="device-name">${name}</span>
          <span class="device-detail">${timeAgo}</span>
        </div>
        ${isCurrent ? '<span class="device-current-badge">Current</span>' : `<button class="device-logout-btn" onclick="logoutSession('${s.id}')">Log Out</button>`}
      </div>`;
  }).join('');
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function logoutSession(sessionId) {
  const sessions = getActiveSessions().filter(s => s.id !== sessionId);
  saveActiveSessions(sessions);
  renderActiveDevices();
  showToast('Device logged out');
}

function logoutAllDevices() {
  const sessionId = localStorage.getItem('chadapp_my_session');
  const sessions = getActiveSessions().filter(s => s.id === sessionId);
  saveActiveSessions(sessions);
  renderActiveDevices();
  showToast('All other devices logged out');
}

// ====== TOAST & UTILITIES ======
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('active');
  setTimeout(() => toast.classList.remove('active'), 2000);
}

function handleAvatarError(img) {
  if (!img) return;
  img.style.display = 'none';
  if (img.nextSibling && img.nextSibling.classList && img.nextSibling.classList.contains('avatar-fallback')) return;
  const fallback = document.createElement('div');
  fallback.className = 'avatar-fallback';
  const icon = document.createElement('i');
  icon.className = 'fas fa-user';
  fallback.appendChild(icon);
  img.parentNode.insertBefore(fallback, img.nextSibling);
}

function initAvatars() {
  document.querySelectorAll('img[src="x"], img[src=""]').forEach(img => {
    if (img.complete && img.naturalWidth > 0) return;
    handleAvatarError(img);
  });
}

function applyAvatar(url) {
  document.querySelectorAll('.profile-avatar-img, .menu-avatar img').forEach(img => {
    const parent = img.parentNode;
    const fallback = parent.querySelector('.avatar-fallback');
    if (fallback) fallback.remove();
    img.style.display = '';
    img.src = url;
  });
}

// ====== EMOJI PICKER ======
const emojiList = ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😗','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','😐','😑','😶','😏','😒','🙄','😬','🤥','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','🤠','🥳','🥺','😢','😭','😤','😠','😡','🤬','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✌️','🤞','🤟','🤘','👌','🤏','👈','👉','👆','👇','☝️','✋','🤚','🖐','🖖','👋','🤙','💪','🦵','🦶','👂','🦻','👃','🧠','🦷','🦴','👀','👁','👅','👄'];

function toggleEmojiPicker() {
  const picker = document.getElementById('emojiPicker');
  picker.classList.toggle('active');
  if (picker.classList.contains('active') && !picker.children.length) {
    emojiList.forEach(emoji => {
      const span = document.createElement('span');
      span.textContent = emoji;
      span.className = 'emoji-item';
      span.onclick = () => insertEmoji(emoji);
      picker.appendChild(span);
    });
  }
}

function insertEmoji(emoji) {
  const input = document.getElementById('chatInput');
  input.value += emoji;
  input.focus();
  document.getElementById('sendBtn').classList.toggle('visible', input.value.trim().length > 0);
}

document.addEventListener('click', function(e) {
  const picker = document.getElementById('emojiPicker');
  if (picker.classList.contains('active') && !e.target.closest('.emoji-picker') && !e.target.closest('.fa-smile')) picker.classList.remove('active');
});

// ====== LANGUAGE ======
const translations = {
  English: {
    'welcome.title': 'Hello !',
    'welcome.desc': 'WELCOME TO CHATAPP,\nCONNECT WITH FRIENDS WORLDWIDE.',
    'welcome.btn': 'GET STARTED',
    'signup.title': 'Create account',
    'signup.subtitle': 'SIGN UP TO START MESSAGING\nYOUR FRIENDS AND FAMILY',
    'signup.name': 'Name',
    'signup.email': 'Mail',
    'signup.password': 'Password',
    'signup.age': 'Age',
    'signup.gender': 'Gender',
    'signup.gender.select': 'Select...',
    'signup.gender.male': 'Male',
    'signup.gender.female': 'Female',
    'signup.gender.other': 'Other',
    'signup.terms': 'I agree to the terms & conditions',
    'signup.btn': 'SIGN UP',
    'login.title': 'Welcome back',
    'login.subtitle': 'SIGN IN TO CONTINUE\nYOUR CONVERSATIONS',
    'login.btn': 'SIGN IN',
    'menu.profile': 'My Profile',
    'menu.favorites': 'Favorites',
    'menu.messages': 'Messages',
    'menu.settings': 'Settings',
    'menu.footer': 'Stay connected with your loved ones. Chat anytime, anywhere with Chadapp.',
    'nav.home': 'Home',
    'nav.favorite': 'Favorite',
    'nav.chats': 'Chats',
    'nav.profile': 'Profile',
    'profile.edit': 'Edit Profile',
    'settings.account': 'Account',
    'settings.general': 'General',
    'settings.support': 'Support',
    'settings.profile': 'Profile Settings',
    'settings.privacy': 'Privacy',
    'settings.security': 'Security',
    'settings.darkmode': 'Dark Mode',
    'settings.language': 'Language',
    'settings.help': 'Help Center',
    'settings.about': 'About',
    'settings.logout': 'Log Out',
    'search.placeholder': 'Search people, messages...',
  },
  Spanish: {
    'welcome.title': '¡Hola!',
    'welcome.desc': 'BIENVENIDO A CHATAPP,\nCONECTA CON AMIGOS DE TODO EL MUNDO.',
    'welcome.btn': 'COMENZAR',
    'signup.title': 'Crear cuenta',
    'signup.subtitle': 'REGÍSTRATE PARA EMPEZAR A CHATEAR\nCON TUS AMIGOS Y FAMILIA',
    'signup.name': 'Nombre',
    'signup.email': 'Correo',
    'signup.password': 'Contraseña',
    'signup.age': 'Edad',
    'signup.gender': 'Género',
    'signup.gender.select': 'Seleccionar...',
    'signup.gender.male': 'Masculino',
    'signup.gender.female': 'Femenino',
    'signup.gender.other': 'Otro',
    'signup.terms': 'Acepto los términos y condiciones',
    'signup.btn': 'REGISTRARSE',
    'login.title': 'Bienvenido de nuevo',
    'login.subtitle': 'INICIA SESIÓN PARA CONTINUAR\nTUS CONVERSACIONES',
    'login.btn': 'INICIAR SESIÓN',
    'menu.profile': 'Mi Perfil',
    'menu.favorites': 'Favoritos',
    'menu.messages': 'Mensajes',
    'menu.settings': 'Ajustes',
    'menu.footer': 'Mantente conectado con tus seres queridos. Chatea cuando quieras, donde quieras con Chadapp.',
    'nav.home': 'Inicio',
    'nav.favorite': 'Favorito',
    'nav.chats': 'Charlas',
    'nav.profile': 'Perfil',
    'profile.edit': 'Editar Perfil',
    'settings.account': 'Cuenta',
    'settings.general': 'General',
    'settings.support': 'Soporte',
    'settings.profile': 'Ajustes de Perfil',
    'settings.privacy': 'Privacidad',
    'settings.security': 'Seguridad',
    'settings.darkmode': 'Modo Oscuro',
    'settings.language': 'Idioma',
    'settings.help': 'Centro de Ayuda',
    'settings.about': 'Acerca de',
    'settings.logout': 'Cerrar Sesión',
    'search.placeholder': 'Buscar personas, mensajes...',
  },
  Hindi: {
    'welcome.title': 'नमस्ते !',
    'welcome.desc': 'चैडैप में आपका स्वागत है,\nदोस्तों से जुड़ें दुनिया भर में.',
    'welcome.btn': 'शुरू करें',
    'signup.title': 'खाता बनाएं',
    'signup.subtitle': 'मैसेज करना शुरू करने के लिए\nसाइन अप करें',
    'signup.name': 'नाम',
    'signup.email': 'ईमेल',
    'signup.password': 'पासवर्ड',
    'signup.age': 'उम्र',
    'signup.gender': 'लिंग',
    'signup.gender.select': 'चुनें...',
    'signup.gender.male': 'पुरुष',
    'signup.gender.female': 'महिला',
    'signup.gender.other': 'अन्य',
    'signup.terms': 'मैं नियमों और शर्तों से सहमत हूं',
    'signup.btn': 'साइन अप करें',
    'login.title': 'वापसी पर स्वागत है',
    'login.subtitle': 'बातचीत जारी रखने के लिए\nसाइन इन करें',
    'login.btn': 'साइन इन करें',
    'menu.profile': 'मेरी प्रोफ़ाइल',
    'menu.favorites': 'पसंदीदा',
    'menu.messages': 'संदेश',
    'menu.settings': 'सेटिंग्स',
    'menu.footer': 'अपने प्रियजनों से जुड़े रहें। चैडैप के साथ कभी भी, कहीं भी चैट करें।',
    'nav.home': 'होम',
    'nav.favorite': 'पसंदीदा',
    'nav.chats': 'चैट',
    'nav.profile': 'प्रोफ़ाइल',
    'profile.edit': 'प्रोफ़ाइल संपादित करें',
    'settings.account': 'खाता',
    'settings.general': 'सामान्य',
    'settings.support': 'सहायता',
    'settings.profile': 'प्रोफ़ाइल सेटिंग्स',
    'settings.privacy': 'गोपनीयता',
    'settings.security': 'सुरक्षा',
    'settings.darkmode': 'डार्क मोड',
    'settings.language': 'भाषा',
    'settings.help': 'सहायता केंद्र',
    'settings.about': 'हमारे बारे में',
    'settings.logout': 'लॉग आउट',
    'search.placeholder': 'लोगों, संदेशों को खोजें...',
  }
};

const currentLang = localStorage.getItem('chadapp_lang') || 'English';

function applyLanguage(lang) {
  localStorage.setItem('chadapp_lang', lang);
  const t = translations[lang] || translations.English;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (t[key] !== undefined) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = t[key];
      else el.textContent = t[key];
    }
  });
}

function selectLanguage(element, language) {
  document.querySelectorAll('.language-item').forEach(i => i.classList.remove('active'));
  element.classList.add('active');
  document.getElementById('currentLanguage').textContent = language;
  applyLanguage(language);
  showToast('Language changed to ' + language);
}

// Allow Request from Strangers
async function toggleAllowRequests(el) {
  const toggle = el.querySelector('.toggle-switch');
  if (!toggle) return;
  toggle.classList.toggle('active');
  if (currentUserId) {
    try { await sb.from('profiles').update({ allow_requests: toggle.classList.contains('active') }).eq('id', currentUserId); } catch (e) {}
  }
}

async function applyAllowRequestsToggle() {
  if (!currentUserId) return;
  try {
    const { data } = await sb.from('profiles').select('allow_requests').eq('id', currentUserId).single();
    const toggle = document.getElementById('allowRequestsToggle');
    if (toggle) toggle.classList.toggle('active', data?.allow_requests !== false);
  } catch (e) {}
}

function togglePasswordVisibility(icon) {
  const input = icon.parentElement.querySelector('input');
  if (!input) return;
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  icon.className = isPassword ? 'fas fa-eye-slash toggle-password' : 'fas fa-eye toggle-password';
}

function toggleTerms(icon) {
  const dropdown = document.getElementById('termsDropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('open');
  if (icon) icon.classList.toggle('open');
}

function closeChatSearch(el) {
  el.parentElement.remove();
  getMessages().then(msgs => renderChatMessages(msgs));
}



// ====== INIT ======
// fallback: force hide loading screen after 5s no matter what
setTimeout(() => {
  const el = document.getElementById('appLoading');
  if (el) el.style.display = 'none';
}, 5000);

(async function init() {
  initAvatars();
  applyLanguage(currentLang);

  try {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
    if (!profile) {
      currentUserId = session.user.id;
      document.getElementById('appLoading').style.display = 'none';
      navigateTo('screen-complete-profile');
      return;
    }
    currentUserId = session.user.id;
    currentUserProfile = profile;
    currentUserName = profile.name || '';
    document.querySelector('.menu-name').textContent = profile.name || '';
    document.getElementById('profileDisplayName').textContent = profile.name || '';
    document.getElementById('displayNameValue').textContent = profile.name || '';
    document.getElementById('emailValue').textContent = profile.email || '';
    document.getElementById('profileDisplayEmail').textContent = profile.email || '-';
    document.getElementById('profileDisplayAge').textContent = profile.age || '-';
    document.getElementById('profileDisplayGender').textContent = profile.gender || '-';
    document.getElementById('profileDisplayRole').textContent = 'New user';
    document.getElementById('ageValue').textContent = profile.age || '-';
    document.getElementById('genderValue').textContent = profile.gender || '-';
    if (profile.avatar) { applyAvatar(profile.avatar); }
    applySavedStatus(profile.status);
    await loadAllData();
    await loadBlockedUsers();
    await applyAllowRequestsToggle();
    subscribeMessages();
    registerCurrentSession();
    document.getElementById('appLoading').style.display = 'none';
    navigateTo('screen-conversations');
  } else {
    document.getElementById('appLoading').style.display = 'none';
    const savedScreen = localStorage.getItem('chadapp_last_screen');
    const validScreens = ['screen-welcome', 'screen-signup', 'screen-login'];
    navigateTo(validScreens.includes(savedScreen) ? savedScreen : 'screen-welcome');
  }
  } catch(e) {
    document.getElementById('appLoading').style.display = 'none';
    navigateTo('screen-welcome');
  }
})();

window.addEventListener('beforeunload', function() {
  unregisterCurrentSession();
});

window.addEventListener('storage', function(e) {
  if (e.key && e.key.startsWith('chadapp_sessions_')) {
    if (document.querySelector('.screen.active')?.id === 'screen-active-devices') renderActiveDevices();
  }
});
