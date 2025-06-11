/*************************************************************************
 * index.js — Express + Kick.js (чтение) + нативный fetch (отправка) +
 * WebSocket (оверлей) + Multer + сессии
 *************************************************************************/

const express       = require('express');
const session       = require('express-session');
const multer        = require('multer');
const fs            = require('fs');
const path          = require('path');
const WebSocket     = require('ws');
const { createClient } = require('@retconned/kick-js');

// --- Загрузка конфига ---
const configPath = path.join(__dirname, 'config.json');
const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// --- Состояние ---
let participants = [];
let collecting   = false;
let isOpen       = false;

// --- Express + сессии ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'mySuperSecretKey',
  resave: false,
  saveUninitialized: false
}));

// --- Multer для загрузки скинов ---
const uploadFolder = path.join(__dirname, 'public', 'img');
if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadFolder),
  filename:  (_, file, cb) => {
    const target = path.join(uploadFolder, file.originalname);
    cb(null, fs.existsSync(target)
      ? file.originalname
      : `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// --- Страницы входа и настроек ---
app.get('/login',         (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.post('/login',        (req, res) => {
  const { username, password } = req.body;
  if (username === 'StarGalaxy' && password === 'FuckTheWorld1996') {
    req.session.authenticated = true;
    return res.redirect('/settings.html');
  }
  res.redirect('/login?error=1');
});
app.get('/settings.html', (req, res) => {
  if (req.session.authenticated) return res.sendFile(path.join(__dirname, 'public/settings.html'));
  res.redirect('/login');
});

// --- UI-маршруты управления оверлеем ---
app.get('/participants-count', (req, res) => {
  res.json({ count: participants.length });
});
app.post('/start-collection', async (req, res) => {
  if (!req.session.authenticated) return res.status(403).json({ error: 'Not authorized' });
  await startCollection();
  res.json({ success: true });
});
app.post('/open-overlay', (req, res) => {
  if (!req.session.authenticated) return res.status(403).json({ error: 'Not authorized' });
  isOpen = true;
  broadcast({ type: 'open' });
  res.json({ success: true });
});
app.post('/roll', async (req, res) => {
  if (!req.session.authenticated) return res.status(403).json({ error: 'Not authorized' });
  if (!isOpen)            return res.status(400).json({ error: 'Overlay is not open' });
  if (!participants.length) return res.status(400).json({ error: 'No participants' });

  collecting = false;
  const winner  = participants[Math.floor(Math.random() * participants.length)];
  const delayMs = (config.chatDelay || 130) * 1000;

  // Отправка финального сообщения
  setTimeout(() => sendChatMessage(`Congratulations @${winner}!`), delayMs);

  broadcast({
    type:       'roll',
    winner,
    participants,
    dropMode:   config.dropMode,
    fixedSkin:  config.fixedSkin
  });
  isOpen = false;
  res.json({ success: true, winner });
});

// --- Настройки + сохранение ---
app.get('/get-settings', (req, res) => res.json(config));
app.post('/save-settings', (req, res) => {
  Object.assign(config, req.body);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json({ message: 'Настройки сохранены. Перезапустите сервер.' });
  broadcast({ type: 'settings-updated' });
});

// --- Загрузка файлов скинов ---
app.post('/upload-skin', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  res.json({ path: '/img/' + req.file.filename });
});

// --- Статика + WebSocket для оверлея ---
app.use(express.static(path.join(__dirname, 'public')));
const server = app.listen(process.env.PORT || 8080, () =>
  console.log(`[SERVER] Запущен на порту ${server.address().port}`)
);
const wss = new WebSocket.Server({ server });
wss.on('connection', () => console.log('[WS] Overlay connected'));
function broadcast(data) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
  });
}

// --- Запуск сбора участников ---
async function startCollection() {
  collecting   = true;
  participants = [];
  broadcast({ type: 'updateParticipants', participants });
  await sendChatMessage('Type !galaxy in chat to join!');
}

// --- HTTP-API для отправки сообщений в Kick чат ---
async function sendChatMessage(content) {
  // выдергиваем XSRF из куки
  const raw = config.COOKIES;
  const m   = raw.match(/XSRF-TOKEN=([^;]+)/);
  const xsrf = m ? decodeURIComponent(m[1]) : '';
  // здесь используем нативный fetch
  await fetch(`https://kick.com/api/v1/chat/post?channel=${config.BOT_CHANNEL}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'cookie':        raw,
      'x-xsrf-token':  xsrf,
      'authorization': `Bearer ${config.BEARER_TOKEN}`
    },
    body: JSON.stringify({ content })
  });
}

// --- Чтение чата через @retconned/kick-js ---
const kickClient = createClient(config.BOT_CHANNEL, { logger: true, readOnly: false });

(async() => {
  try {
    console.log('Starting authentication process with tokens ...');
    await kickClient.login({
      type: 'tokens',
      credentials: {
        bearerToken: config.BEARER_TOKEN,
        cookies:     config.COOKIES
      }
    });
    console.log('[KICK] Bot ready');

    kickClient.on('ChatMessage', async msg => {
      const user  = msg.sender.username.toLowerCase();
      const text  = msg.content.trim().toLowerCase();
      const roles = msg.sender.roles || [];

      if (text === '!letsgo' && roles.includes('owner')) {
        await startCollection();
      }
      if (text === '!open' && roles.includes('owner')) {
        isOpen = true;
        broadcast({ type: 'open' });
      }
      if (collecting && text === '!galaxy' && !participants.includes(user)) {
        participants.push(user);
        await sendChatMessage(`@${user}, you joined!`);
        broadcast({ type: 'updateParticipants', participants });
      }
      if (text === '!roll' && roles.includes('owner')) {
        if (!isOpen || !participants.length) return;
        collecting = false;
        const winner = participants[Math.floor(Math.random() * participants.length)];
        await sendChatMessage(`Congratulations @${winner}!`);
        broadcast({
          type:       'roll',
          winner,
          participants,
          dropMode:   config.dropMode,
          fixedSkin:  config.fixedSkin
        });
        isOpen = false;
      }
    });

  } catch (err) {
    console.error('Kick login error:', err);
  }
})();
