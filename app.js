// Configuration
const SIGNALING_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000/signaling'
    : 'wss://your-signaling-server.herokuapp.com/signaling'; // Update with your server URL

// State
let connection = null;
let localStream = null;
let peerConnections = {};
let isMuted = false;
let isDeafened = false;
let myConnectionId = null;
let myUsername = localStorage.getItem('username') || 'Guest' + Math.floor(Math.random() * 1000);
let currentChannel = 'general';
let currentVoiceChannel = null;
let channels = ['general'];
let voiceChannels = ['general-voice'];
let users = {};

// STUN server configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

// Initialize SignalR connection
async function initSignalR() {
    try {
        connection = new signalR.HubConnectionBuilder()
            .withUrl(SIGNALING_URL)
            .build();

        // Connection events
        connection.on("UserJoined", (connectionId, username) => {
            console.log("User joined:", connectionId, username);
            if (connectionId !== myConnectionId) {
                users[connectionId] = { id: connectionId, username: username || 'Guest', inVoice: false };
                updateUsersList();
                if (currentVoiceChannel) {
                    createPeerConnection(connectionId, true);
                }
            }
        });

        connection.on("UserLeft", (connectionId) => {
            console.log("User left:", connectionId);
            if (peerConnections[connectionId]) {
                peerConnections[connectionId].close();
                delete peerConnections[connectionId];
            }
            delete users[connectionId];
            updateUsersList();
        });

        connection.on("ReceiveOffer", async (offer, fromConnectionId) => {
            console.log("Received offer from:", fromConnectionId);
            if (!peerConnections[fromConnectionId]) {
                await createPeerConnection(fromConnectionId, false);
            }
            const pc = peerConnections[fromConnectionId];
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await connection.invoke("SendAnswer", answer.sdp, fromConnectionId);
        });

        connection.on("ReceiveAnswer", async (answer, fromConnectionId) => {
            console.log("Received answer from:", fromConnectionId);
            const pc = peerConnections[fromConnectionId];
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer }));
            }
        });

        connection.on("ReceiveIceCandidate", async (candidate, sdpMid, sdpMLineIndex, fromConnectionId) => {
            console.log("Received ICE candidate from:", fromConnectionId);
            const pc = peerConnections[fromConnectionId];
            if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid, sdpMLineIndex }));
            }
        });

        // Channel and message events
        connection.on("ChannelCreated", (channelName, channelType) => {
            if (channelType === 'text') {
                if (!channels.includes(channelName)) {
                    channels.push(channelName);
                    addChannelToUI(channelName, 'text');
                }
            } else if (channelType === 'voice') {
                if (!voiceChannels.includes(channelName)) {
                    voiceChannels.push(channelName);
                    addChannelToUI(channelName, 'voice');
                }
            }
        });

        connection.on("MessageReceived", (message, author, timestamp, channel) => {
            if (channel === currentChannel) {
                addMessageToUI(message, author, timestamp);
            }
        });

        connection.on("UserJoinedVoice", (connectionId, channelName) => {
            if (users[connectionId]) {
                users[connectionId].inVoice = true;
                users[connectionId].voiceChannel = channelName;
            }
            updateUsersList();
        });

        connection.on("UserLeftVoice", (connectionId) => {
            if (users[connectionId]) {
                users[connectionId].inVoice = false;
                users[connectionId].voiceChannel = null;
            }
            updateUsersList();
        });

        connection.onclose(() => {
            updateUserStatus('Offline');
            document.getElementById("btnMute").disabled = true;
        });

        // Connect automatically
        await connect();
    } catch (error) {
        console.error("Error initializing SignalR:", error);
    }
}

// Connect to server
async function connect() {
    try {
        await connection.start();
        myConnectionId = connection.connectionId;
        console.log("Connected with ID:", myConnectionId);
        
        // Send username to server
        await connection.invoke("SetUsername", myConnectionId, myUsername);
        
        // Get user media
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("Got local stream");
        
        updateUserStatus('Online');
        updateUsername();
        
        // Get existing channels
        await connection.invoke("GetChannels");
    } catch (error) {
        console.error("Error connecting:", error);
        alert("Failed to connect to server. Make sure Signaling Server is running.");
    }
}

// Create peer connection
async function createPeerConnection(connectionId, isInitiator) {
    try {
        const pc = new RTCPeerConnection(rtcConfig);

        // Add local stream tracks
        if (localStream && !isMuted && !isDeafened) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                connection.invoke("SendIceCandidate", 
                    event.candidate.candidate,
                    event.candidate.sdpMid,
                    event.candidate.sdpMLineIndex,
                    connectionId);
            }
        };

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log("Received remote stream from:", connectionId);
            if (!isDeafened) {
                const remoteAudio = new Audio();
                remoteAudio.srcObject = event.streams[0];
                remoteAudio.play();
            }
        };

        // Handle connection state
        pc.onconnectionstatechange = () => {
            console.log("Connection state:", pc.connectionState);
        };

        peerConnections[connectionId] = pc;

        // Create offer if initiator
        if (isInitiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await connection.invoke("SendOffer", offer.sdp, connectionId);
        }
    } catch (error) {
        console.error("Error creating peer connection:", error);
    }
}

// Channel management
function selectChannel(channelName) {
    currentChannel = channelName;
    document.querySelectorAll('.channel-item').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelector(`[data-channel="${channelName}"]`).classList.add('active');
    document.getElementById('currentChannelName').textContent = `# ${channelName}`;
    document.getElementById('messageInput').placeholder = `Message #${channelName}`;
    
    // Clear and reload messages for this channel
    const container = document.getElementById('messagesContainer');
    container.innerHTML = '';
    container.innerHTML = `<div class="welcome-message">
        <h1>Welcome to #${channelName}!</h1>
        <p>This is the start of the #${channelName} channel.</p>
    </div>`;
    
    // Request messages for this channel
    connection.invoke("GetChannelMessages", channelName);
}

function joinVoiceChannel(channelName) {
    if (currentVoiceChannel === channelName) {
        leaveVoiceChannel();
        return;
    }
    
    leaveVoiceChannel();
    currentVoiceChannel = channelName;
    
    // Update UI
    document.querySelectorAll('.channel-item.voice').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelector(`[data-voice-channel="${channelName}"]`).classList.add('active');
    
    // Notify server
    connection.invoke("JoinVoiceChannel", channelName);
    
    // Connect to all users in this voice channel
    Object.keys(users).forEach(userId => {
        if (users[userId].voiceChannel === channelName && userId !== myConnectionId) {
            createPeerConnection(userId, true);
        }
    });
}

function leaveVoiceChannel() {
    if (currentVoiceChannel) {
        connection.invoke("LeaveVoiceChannel", currentVoiceChannel);
        
        // Close all peer connections
        Object.keys(peerConnections).forEach(connId => {
            peerConnections[connId].close();
            delete peerConnections[connId];
        });
        
        currentVoiceChannel = null;
        document.querySelectorAll('.channel-item.voice').forEach(item => {
            item.classList.remove('active');
        });
    }
}

function showCreateChannelModal() {
    document.getElementById('createChannelModal').classList.add('show');
    document.getElementById('newChannelName').focus();
}

function showCreateVoiceChannelModal() {
    document.getElementById('createVoiceChannelModal').classList.add('show');
    document.getElementById('newVoiceChannelName').focus();
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

function createChannel() {
    const name = document.getElementById('newChannelName').value.trim().toLowerCase().replace(/\s+/g, '-');
    if (name && !channels.includes(name)) {
        connection.invoke("CreateChannel", name, 'text');
        closeModal('createChannelModal');
        document.getElementById('newChannelName').value = '';
    }
}

function createVoiceChannel() {
    const name = document.getElementById('newVoiceChannelName').value.trim().toLowerCase().replace(/\s+/g, '-');
    if (name && !voiceChannels.includes(name)) {
        connection.invoke("CreateChannel", name, 'voice');
        closeModal('createVoiceChannelModal');
        document.getElementById('newVoiceChannelName').value = '';
    }
}

function addChannelToUI(channelName, type) {
    if (type === 'text') {
        const list = document.getElementById('channelsList');
        const item = document.createElement('div');
        item.className = 'channel-item';
        item.setAttribute('data-channel', channelName);
        item.onclick = () => selectChannel(channelName);
        item.innerHTML = `<span>#</span> ${channelName}`;
        list.appendChild(item);
    } else if (type === 'voice') {
        const list = document.getElementById('voiceChannelsList');
        const item = document.createElement('div');
        item.className = 'channel-item voice';
        item.setAttribute('data-voice-channel', channelName);
        item.onclick = () => joinVoiceChannel(channelName);
        item.innerHTML = `<span>🔊</span> ${channelName.replace(/-/g, ' ')}`;
        list.appendChild(item);
    }
}

// Message handling
function handleMessageKeyPress(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (message && connection && connection.state === signalR.HubConnectionState.Connected) {
        connection.invoke("SendMessage", message, currentChannel);
        input.value = '';
    }
}

function addMessageToUI(message, author, timestamp) {
    const container = document.getElementById('messagesContainer');
    const welcomeMsg = container.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.remove();
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = author.charAt(0).toUpperCase();
    
    const content = document.createElement('div');
    content.className = 'message-content';
    
    const header = document.createElement('div');
    header.className = 'message-header';
    
    const authorSpan = document.createElement('span');
    authorSpan.className = 'message-author';
    authorSpan.textContent = author;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-timestamp';
    timeSpan.textContent = new Date(timestamp).toLocaleTimeString();
    
    header.appendChild(authorSpan);
    header.appendChild(timeSpan);
    
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message;
    
    content.appendChild(header);
    content.appendChild(text);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
}

// User management
function updateUsersList() {
    const list = document.getElementById('usersList');
    list.innerHTML = '';
    
    // Add self
    const selfItem = document.createElement('div');
    selfItem.className = 'user-item' + (currentVoiceChannel ? ' voice-active' : '');
    selfItem.innerHTML = `
        <div class="user-item-avatar">${myUsername.charAt(0).toUpperCase()}</div>
        <div class="user-item-name">${myUsername} (You)</div>
    `;
    list.appendChild(selfItem);
    
    // Add other users
    Object.values(users).forEach(user => {
        const item = document.createElement('div');
        item.className = 'user-item' + (user.inVoice ? ' voice-active' : '');
        item.innerHTML = `
            <div class="user-item-avatar">${user.username.charAt(0).toUpperCase()}</div>
            <div class="user-item-name">${user.username}</div>
        `;
        list.appendChild(item);
    });
    
    document.getElementById('usersCount').textContent = Object.keys(users).length + 1;
}

function updateUsername() {
    document.getElementById('username').textContent = myUsername;
    document.getElementById('userAvatar').textContent = myUsername.charAt(0).toUpperCase();
}

function updateUserStatus(status) {
    document.getElementById('userStatus').textContent = status;
}

// Settings
function showSettingsModal() {
    document.getElementById('settingsUsername').value = myUsername;
    document.getElementById('settingsModal').classList.add('show');
}

function saveSettings() {
    const newUsername = document.getElementById('settingsUsername').value.trim();
    if (newUsername) {
        myUsername = newUsername;
        localStorage.setItem('username', myUsername);
        updateUsername();
        if (connection && connection.state === signalR.HubConnectionState.Connected) {
            connection.invoke("SetUsername", myConnectionId, myUsername);
        }
        closeModal('settingsModal');
    }
}

// Audio controls
function toggleMute() {
    isMuted = !isMuted;
    
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });
    }
    
    const btn = document.getElementById("btnMute");
    btn.textContent = isMuted ? "🔇" : "🔊";
    btn.style.opacity = isMuted ? "0.5" : "1";
}

function toggleDeafen() {
    isDeafened = !isDeafened;
    
    // Mute all remote audio
    Object.values(peerConnections).forEach(pc => {
        pc.getReceivers().forEach(receiver => {
            if (receiver.track && receiver.track.kind === 'audio') {
                receiver.track.enabled = !isDeafened;
            }
        });
    });
    
    const btn = document.getElementById("btnDeafen");
    btn.textContent = isDeafened ? "🔇" : "🔊";
    btn.style.opacity = isDeafened ? "0.5" : "1";
    
    // Also mute when deafened
    if (isDeafened && !isMuted) {
        toggleMute();
    }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    initSignalR();
    updateUsername();
    updateUsersList();
    
    // Close modals on outside click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('show');
            }
        });
    });
});
