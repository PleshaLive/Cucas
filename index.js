/*************************************************************************
 * index.js — серверная логика (Express + TMI.js + WebSocket + аутентификация 
 * и управление оверлеем через веб-интерфейс + поддержка Channel Points)
 *************************************************************************/

const express       = require('express');
const multer        = require('multer');
const fs            = require('fs');
const path          = require('path');
const WebSocket     = require('ws');
const tmi           = require('tmi.js');
const session       = require('express-session');

// ————————————————————————————————
// 1. Настройка загрузки файлов (скинов)
// ————————————————————————————————
const uploadFolder = path.join(__dirname, 'public', 'img');
if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadFolder),
  filename:    (req, file, cb) => {
    const target = path.join(uploadFolder, file.originalname);
    if (fs.existsSync(target)) {
      cb(null, file.originalname);
    } else {
      cb(null, Date.now() + '-' + file.originalname);
    }
  }
});
const upload = multer({ storage });

// ————————————————————————————————
// 2. Загрузка или создание config.json
// ————————————————————————————————
const configPath = path.join(__dirname, 'config.json');
let config = {
  BOT_USERNAME:         'Your_Bot_Login',
  BOT_OAUTH:            'oauth:xxxxxx',
  CHANNEL_NAME:         'your_channel',
  chatDelay:            130,
  skins:                [],
  dropMode:             'random',
  fixedSkin:            null,
  rarityChances:        {
    "Mil-Spec": 79.9,
    "Restricted": 16,
    "Classified": 3.2,
    "Covert": 0.64,
    "Rare Special Items": 0.125
  },
  channelPointRewardId: '',
  channelPointCost:     0
};
try {
  const file = fs.readFileSync(configPath, 'utf8');
  Object.assign(config, JSON.parse(file));
} catch (err) {
  console.log('Используется конфиг по умолчанию (config.json не найден или неверен).');
}

// ————————————————————————————————
// 3. Express + сессии + статика
// ————————————————————————————————
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret:            'mySuperSecretKey', // можно вынести в переменную окружения при желании
  resave:            false,
  saveUninitialized: false
}));

// Статика (public/)
app.use(express.static(path.join(__dirname, 'public')));

// ————————————————————————————————
// 4. Маршруты аутентификации
// ————————————————————————————————
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'StarGalaxy' && password === 'FuckTheWorld1996') {
    req.session.authenticated = true;
    return res.redirect('/settings.html');
  }
  res.redirect('/login?error=1');
});
app.get('/settings.html', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.sendFile(path.join(__dirname, 'public', 'settings.html'));
  }
  res.redirect('/login');
});

// ————————————————————————————————
// 5. Участники + WebSocket
// ————————————————————————————————
let collecting   = false;
let participants = [];
let isOpen       = false;

app.get('/participants-count', (req, res) => {
  res.json({ count: participants.length });
});

function broadcast(data) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(data));
    }
  });
}
function sendParticipantsUpdate() {
  broadcast({ type: 'updateParticipants', participants });
}
function sendOpenToOverlay() {
  broadcast({ type: 'open' });
}
function sendRollToOverlay(winner) {
  const payload = { type: 'roll', winner, participants };
  if (config.dropMode === 'preset' && config.fixedSkin) {
    payload.fixedSkin = config.fixedSkin;
  }
  broadcast(payload);
}

function startCollection() {
  collecting   = true;
  participants = [];
  sendParticipantsUpdate();
  client.say(config.CHANNEL_NAME,
    'Type !letsgo in chat to join the giveaway!'
  );
}

// ————————————————————————————————
// 6. Маршруты управления оверлеем
// ————————————————————————————————
app.post('/start-collection', (req, res) => {
  if (!(req.session && req.session.authenticated)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  startCollection();
  res.json({ success: true });
});
app.post('/open-overlay', (req, res) => {
  if (!(req.session && req.session.authenticated)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  isOpen = true;
  sendOpenToOverlay();
  res.json({ success: true });
});
app.post('/roll', (req, res) => {
  if (!(req.session && req.session.authenticated)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  if (!isOpen) {
    return res.status(400).json({ error: 'Overlay is not open' });
  }
  if (participants.length === 0) {
    return res.status(400).json({ error: 'No participants' });
  }
  collecting = false;
  const winner = participants[Math.floor(Math.random() * participants.length)];
  setTimeout(() => {
    client.say(config.CHANNEL_NAME, "Let's congratulate the winner!");
  }, config.chatDelay * 1000);
  sendRollToOverlay(winner);
  isOpen = false;
  res.json({ success: true, winner });
});

// ————————————————————————————————
// 7. Настройки / загрузка скинов
// ————————————————————————————————
app.get('/get-settings', (req, res) => {
  res.json(config);
});
app.post('/save-settings', (req, res) => {
  const nc = req.body;
  config.BOT_USERNAME        = nc.BOT_USERNAME        || config.BOT_USERNAME;
  config.BOT_OAUTH           = nc.BOT_OAUTH           || config.BOT_OAUTH;
  config.CHANNEL_NAME        = nc.CHANNEL_NAME        || config.CHANNEL_NAME;
  config.chatDelay           = nc.chatDelay           || config.chatDelay;
  if (Array.isArray(nc.skins)) config.skins = nc.skins;
  config.dropMode            = nc.dropMode            || config.dropMode;
  config.fixedSkin           = nc.fixedSkin           || config.fixedSkin;
  config.rarityChances       = nc.rarityChances       || config.rarityChances;
  config.channelPointRewardId= nc.channelPointRewardId|| config.channelPointRewardId;
  config.channelPointCost    = nc.channelPointCost    || config.channelPointCost;

  fs.writeFile(configPath, JSON.stringify(config, null, 2), err => {
    if (err) {
      console.error('Ошибка записи config.json:', err);
      return res.status(500).json({ message: 'Ошибка сохранения настроек' });
    }
    broadcast({ type: 'settings-updated' });
    res.json({ message: 'Настройки сохранены. Перезапустите сервер для применения изменений.' });
  });
});
app.post('/upload-skin', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }
  res.json({ path: '/img/' + req.file.filename });
});

// ————————————————————————————————
// 8. TMI.js — чат-бот (с Channel Points)
// ————————————————————————————————
const client = new tmi.Client({
  options:    { debug: true },
  connection: { reconnect: true, secure: true },
  identity:   { username: config.BOT_USERNAME, password: config.BOT_OAUTH },
  channels:   [ config.CHANNEL_NAME ]
});

client.on('message', (channel, tags, message, self) => {
  if (self) return;
  const username = tags.username.toLowerCase();
  const msg      = message.trim().toLowerCase();

  // !letsgo от broadcaster
  if (msg === '!letsgo' && tags.badges?.broadcaster === '1') {
    startCollection();
  }

  // !open от broadcaster
  if (msg === '!open' && tags.badges?.broadcaster === '1') {
    isOpen = true;
    sendOpenToOverlay();
  }

  // Покупка через Channel Points
  if (collecting && tags['custom-reward-id'] === config.channelPointRewardId) {
    if (!participants.includes(username)) {
      participants.push(username);
      client.say(
        config.CHANNEL_NAME,
        `@${username}, you've purchased an entry for ${config.channelPointCost} points! Good luck!`
      );
      sendParticipantsUpdate();
    }
  }

  // !roll от broadcaster
  if (msg === '!roll' && tags.badges?.broadcaster === '1') {
    if (!isOpen || !participants.length) return;
    collecting = false;
    const winner = participants[Math.floor(Math.random() * participants.length)];
    setTimeout(() => {
      client.say(config.CHANNEL_NAME, "Let's congratulate the winner!");
    }, config.chatDelay * 1000);
    sendRollToOverlay(winner);
    isOpen = false;
  }
});

client.connect().catch(err => {
  console.error('Ошибка подключения к Twitch:', err);
});

// ————————————————————————————————
// 9. HTTP + WebSocket сервер
// ————————————————————————————————
const PORT   = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`[SERVER] Запущен на порту ${PORT}`);
});
const wss = new WebSocket.Server({ server });

wss.on('connection', () => {
  console.log('[WS] Overlay connected!');
});

// (Express.static уже настроен выше)
