import { signInWithPopup, signOut, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  addDoc, 
  serverTimestamp, 
  getDocs, 
  doc, 
  setDoc, 
  updateDoc, 
  getDoc,
  getDocFromServer,
  Unsubscribe
} from 'firebase/firestore';
import { auth, db, googleProvider } from './lib/firebase';
import { ChatUser, Chat, Message } from './types';
import { formatDistanceToNow, format } from 'date-fns';

// ==========================================
// 1. Mandatory Firebase Connection Verification
// ==========================================
async function testConnection() {
  try {
    // Attempting a simple server fetch to verify the client is authenticated & configured
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// ==========================================
// 2. Mandatory Custom Error Handler (Pillar 3)
// ==========================================
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// ==========================================
// 3. Application State
// ==========================================
let currentUser: FirebaseUser | null = null;
let selectedChatId: string | null = null;
let activeChats: Chat[] = [];
let cachedUsers: { [uid: string]: ChatUser } = {};
let chatsUnsubscribe: Unsubscribe | null = null;
let messagesUnsubscribe: Unsubscribe | null = null;
let searchFilter: string = '';

// ==========================================
// 4. DOM Elements Lookup
// ==========================================
const loginScreen = document.getElementById('login-screen') as HTMLDivElement;
const googleLoginBtn = document.getElementById('google-login-btn') as HTMLButtonElement;
const appScreen = document.getElementById('app-screen') as HTMLDivElement;

const userAvatar = document.getElementById('user-avatar') as HTMLImageElement;
const userName = document.getElementById('user-name') as HTMLParagraphElement;
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement;
const openNewChatBtn = document.getElementById('open-new-chat-btn') as HTMLButtonElement;

const chatSearch = document.getElementById('chat-search') as HTMLInputElement;
const chatListContainer = document.getElementById('chat-list') as HTMLDivElement;

const noChatState = document.getElementById('no-chat-state') as HTMLDivElement;
const activeChatState = document.getElementById('active-chat-state') as HTMLDivElement;
const activeChatAvatar = document.getElementById('active-chat-avatar') as HTMLImageElement;
const activeChatName = document.getElementById('active-chat-name') as HTMLHeadingElement;

const messagesContainer = document.getElementById('messages-container') as HTMLDivElement;
const messageForm = document.getElementById('message-form') as HTMLFormElement;
const messageInput = document.getElementById('message-input') as HTMLInputElement;

const newChatModal = document.getElementById('new-chat-modal') as HTMLDivElement;
const closeModalBtn = document.getElementById('close-modal-btn') as HTMLButtonElement;
const newChatForm = document.getElementById('new-chat-form') as HTMLFormElement;
const newChatEmail = document.getElementById('new-chat-email') as HTMLInputElement;
const newChatError = document.getElementById('new-chat-error') as HTMLParagraphElement;

// ==========================================
// 5. Auth Flow & State Observers
// ==========================================
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    // Enforce metadata.json profile sync
    try {
      const userRef = doc(db, 'users', user.uid);
      await setDoc(userRef, {
        uid: user.uid,
        displayName: user.displayName,
        photoURL: user.photoURL,
        email: user.email,
        lastSeen: serverTimestamp(),
      }, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
    }

    // Toggle screens
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');

    // Populate current profile
    userAvatar.src = user.photoURL || 'https://www.gravatar.com/avatar/?d=mp';
    userName.textContent = user.displayName || 'No Name';

    // Start listening to chats
    subscribeToChats();
  } else {
    // Unsubscribe listeners
    cleanupListeners();

    // Toggle screens
    loginScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
    selectedChatId = null;
    activeChats = [];
    cachedUsers = {};
    renderChatList();
    showEmptyState();
  }
});

function cleanupListeners() {
  if (chatsUnsubscribe) {
    chatsUnsubscribe();
    chatsUnsubscribe = null;
  }
  if (messagesUnsubscribe) {
    messagesUnsubscribe();
    messagesUnsubscribe = null;
  }
}

// Auth Handlers
googleLoginBtn.addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    console.error('Login Failed', err);
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
  } catch (err) {
    console.error('Logout Failed', err);
  }
});

// ==========================================
// 6. Realtime Chats Feed
// ==========================================
function subscribeToChats() {
  if (!currentUser) return;

  const path = 'chats';
  const q = query(
    collection(db, path),
    where('participants', 'array-contains', currentUser.uid),
    orderBy('updatedAt', 'desc')
  );

  chatsUnsubscribe = onSnapshot(q, (snapshot) => {
    const list: Chat[] = [];
    snapshot.forEach(docSnap => {
      list.push({ id: docSnap.id, ...docSnap.data() } as Chat);
    });
    activeChats = list;
    
    // Proactively fetch profiles for the participants in parallel
    list.forEach(chat => {
      chat.participants.forEach(async (uid) => {
        if (currentUser && uid !== currentUser.uid && !cachedUsers[uid]) {
          try {
            const userSnap = await getDocs(query(collection(db, 'users'), where('uid', '==', uid)));
            if (!userSnap.empty) {
              const userData = userSnap.docs[0].data() as ChatUser;
              cachedUsers[uid] = userData;
              renderChatList();
              
              // If we are currently talking to this user, update the active chat header
              if (selectedChatId === chat.id) {
                updateActiveChatHeader(userData);
              }
            }
          } catch (err) {
            handleFirestoreError(err, OperationType.GET, `users/${uid}`);
          }
        }
      });
    });

    renderChatList();
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, path);
  });
}

// Render Conversation list in sidebar
function renderChatList() {
  chatListContainer.innerHTML = '';
  
  const filtered = activeChats.filter(chat => {
    if (!currentUser) return false;
    const otherUserId = chat.participants.find(id => id !== currentUser?.uid);
    const otherUser = otherUserId ? cachedUsers[otherUserId] : null;
    if (!otherUser) return true; // Show until loaded
    const nameMatch = (otherUser.displayName || '').toLowerCase().includes(searchFilter.toLowerCase());
    const emailMatch = (otherUser.email || '').toLowerCase().includes(searchFilter.toLowerCase());
    return nameMatch || emailMatch;
  });

  if (filtered.length === 0) {
    chatListContainer.innerHTML = `
      <div class="p-8 text-center text-slate-400">
        <p class="text-sm">No conversations found.</p>
        <button id="no-chat-prompt" class="text-indigo-600 text-sm font-semibold mt-2 hover:underline cursor-pointer">Start one now</button>
      </div>
    `;
    const noChatPrompt = document.getElementById('no-chat-prompt');
    if (noChatPrompt) {
      noChatPrompt.addEventListener('click', () => toggleModal(true));
    }
    return;
  }

  filtered.forEach(chat => {
    if (!currentUser) return;
    const otherUserId = chat.participants.find(id => id !== currentUser.uid);
    const otherUser = otherUserId ? cachedUsers[otherUserId] : null;

    const button = document.createElement('button');
    button.className = `w-full p-4 flex items-center gap-3 hover:bg-slate-50 transition-all border-l-4 text-left cursor-pointer ${
      selectedChatId === chat.id ? 'bg-indigo-50/50 border-indigo-600' : 'border-transparent'
    }`;

    // Compute relative time or nice fallback
    let formattedTime = '';
    if (chat.updatedAt?.toDate) {
      try {
        formattedTime = formatDistanceToNow(chat.updatedAt.toDate(), { addSuffix: false });
      } catch {
        formattedTime = 'just now';
      }
    }

    const avatarUrl = otherUser?.photoURL || 'https://www.gravatar.com/avatar/?d=mp';
    const displayName = otherUser?.displayName || 'Loading...';
    const lastMsg = chat.lastMessage || 'Started a new conversation';

    button.innerHTML = `
      <div class="relative flex-shrink-0">
        <img src="${avatarUrl}" alt="" class="w-12 h-12 rounded-full object-cover border border-slate-100" referrerpolicy="no-referrer" />
        <span class="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-baseline mb-0.5">
          <p class="text-sm font-bold text-slate-900 truncate">${displayName}</p>
          <span class="text-[10px] text-slate-400 whitespace-nowrap ml-2">${formattedTime}</span>
        </div>
        <p class="text-xs text-slate-500 truncate leading-relaxed">${lastMsg}</p>
      </div>
    `;

    button.addEventListener('click', () => {
      selectChat(chat.id);
    });

    chatListContainer.appendChild(button);
  });
}

// Handle Filtering Sidebar
chatSearch.addEventListener('input', (e) => {
  searchFilter = (e.target as HTMLInputElement).value;
  renderChatList();
});

// ==========================================
// 7. Active Chat Details & Messages
// ==========================================
function selectChat(chatId: string) {
  selectedChatId = chatId;
  
  // Show active state, hide empty state
  noChatState.classList.add('hidden');
  activeChatState.classList.remove('hidden');

  // Trigger update on sidebar highlighting
  renderChatList();

  // Reset chat header with placeholder or cached data
  const chat = activeChats.find(c => c.id === chatId);
  if (chat && currentUser) {
    const otherUserId = chat.participants.find(id => id !== currentUser?.uid);
    const otherUser = otherUserId ? cachedUsers[otherUserId] : null;
    if (otherUser) {
      updateActiveChatHeader(otherUser);
    } else {
      activeChatName.textContent = 'Loading...';
      activeChatAvatar.src = 'https://www.gravatar.com/avatar/?d=mp';
    }
  }

  // Subscribe to messages
  subscribeToMessages(chatId);
}

function updateActiveChatHeader(user: ChatUser) {
  activeChatName.textContent = user.displayName || 'No Name';
  activeChatAvatar.src = user.photoURL || 'https://www.gravatar.com/avatar/?d=mp';
}

function subscribeToMessages(chatId: string) {
  if (messagesUnsubscribe) {
    messagesUnsubscribe();
  }

  const path = `chats/${chatId}/messages`;
  const q = query(
    collection(db, path),
    orderBy('timestamp', 'asc')
  );

  messagesUnsubscribe = onSnapshot(q, (snapshot) => {
    const msgs: Message[] = [];
    snapshot.forEach(docSnap => {
      msgs.push({ id: docSnap.id, ...docSnap.data() } as Message);
    });
    renderMessages(msgs);
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, path);
  });
}

function renderMessages(messages: Message[]) {
  messagesContainer.innerHTML = '';
  
  if (messages.length === 0) {
    messagesContainer.innerHTML = `
      <div class="h-full flex flex-col items-center justify-center text-slate-400">
        <p class="text-sm">Say hello! No messages yet.</p>
      </div>
    `;
    return;
  }

  messages.forEach((msg, idx) => {
    if (!currentUser) return;
    const isMe = msg.senderId === currentUser.uid;
    
    // Grouping by date or showing fine timestamp bubbles
    const showTime = idx === 0 || 
      (msg.timestamp?.toDate && messages[idx-1].timestamp?.toDate && 
       msg.timestamp.toDate().getTime() - messages[idx-1].timestamp.toDate().getTime() > 300000);

    if (showTime && msg.timestamp?.toDate) {
      const timeBubble = document.createElement('div');
      timeBubble.className = 'flex justify-center my-4';
      timeBubble.innerHTML = `
        <span class="text-[10px] font-bold text-slate-400 bg-white border border-slate-100 px-3 py-1 rounded-full shadow-2xs uppercase tracking-wider">
          ${format(msg.timestamp.toDate(), 'p')}
        </span>
      `;
      messagesContainer.appendChild(timeBubble);
    }

    const container = document.createElement('div');
    container.className = `flex items-end gap-2 ${isMe ? 'justify-end' : 'justify-start'}`;

    const textContent = escapeHtml(msg.text);

    if (isMe) {
      container.innerHTML = `
        <div class="max-w-[75%] p-3.5 px-4 bg-indigo-600 text-white rounded-2xl rounded-br-none text-sm shadow-sm leading-relaxed">
          <p>${textContent}</p>
        </div>
      `;
    } else {
      const otherUserId = activeChats.find(c => c.id === selectedChatId)?.participants.find(id => id !== currentUser?.uid);
      const otherUser = otherUserId ? cachedUsers[otherUserId] : null;
      const otherAvatar = otherUser?.photoURL || 'https://www.gravatar.com/avatar/?d=mp';

      container.innerHTML = `
        <img src="${otherAvatar}" alt="" class="w-6 h-6 rounded-full flex-shrink-0 object-cover" referrerpolicy="no-referrer" />
        <div class="max-w-[75%] p-3.5 px-4 bg-white text-slate-800 rounded-2xl rounded-bl-none text-sm shadow-2xs border border-slate-100 leading-relaxed">
          <p>${textContent}</p>
        </div>
      `;
    }

    messagesContainer.appendChild(container);
  });

  // Smooth scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Send Message Handler
messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedChatId || !currentUser) return;

  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = '';

  const messagesPath = `chats/${selectedChatId}/messages`;
  try {
    // Add document to the subcollection
    await addDoc(collection(db, messagesPath), {
      senderId: currentUser.uid,
      text,
      timestamp: serverTimestamp(),
      type: 'text'
    });

    // Update parent document's lastMessage & updatedAt
    const parentChatPath = `chats/${selectedChatId}`;
    await updateDoc(doc(db, parentChatPath), {
      lastMessage: text,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, messagesPath);
  }
});

// ==========================================
// 8. Create New Conversations Modal
// ==========================================
function toggleModal(show: boolean) {
  if (show) {
    newChatModal.classList.remove('hidden');
    newChatEmail.focus();
  } else {
    newChatModal.classList.add('hidden');
    newChatEmail.value = '';
    newChatError.classList.add('hidden');
    newChatError.textContent = '';
  }
}

openNewChatBtn.addEventListener('click', () => toggleModal(true));
closeModalBtn.addEventListener('click', () => toggleModal(false));

newChatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  newChatError.classList.add('hidden');
  const targetEmail = newChatEmail.value.trim();

  if (targetEmail === currentUser.email) {
    showModalError("You cannot chat with yourself!");
    return;
  }

  try {
    // Find User by Email
    const path = 'users';
    const userSnap = await getDocs(query(collection(db, path), where('email', '==', targetEmail)));
    
    if (userSnap.empty) {
      showModalError('User with this email was not found.');
      return;
    }

    const targetUser = userSnap.docs[0].data() as ChatUser;

    // Check if chat already exists
    const existing = activeChats.find(chat => chat.participants.includes(targetUser.uid));
    if (existing) {
      selectChat(existing.id);
      toggleModal(false);
      return;
    }

    // Start a new conversation
    const newChatRef = await addDoc(collection(db, 'chats'), {
      participants: [currentUser.uid, targetUser.uid],
      updatedAt: serverTimestamp(),
      lastMessage: 'Started a new conversation'
    });

    selectChat(newChatRef.id);
    toggleModal(false);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'chats');
  }
});

function showModalError(message: string) {
  newChatError.textContent = message;
  newChatError.classList.remove('hidden');
}

function showEmptyState() {
  noChatState.classList.remove('hidden');
  activeChatState.classList.add('hidden');
}

// Helpers
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
