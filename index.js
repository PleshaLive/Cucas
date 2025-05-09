#!/usr/bin/env node
import 'dotenv/config';
import fs            from 'fs';
import path          from 'path';
import express       from 'express';
import multer        from 'multer';
import tmi           from 'tmi.js';
import { RefreshingAuthProvider } from '@twurple/auth';
import { ApiClient }              from '@twurple/api';
import { EventSubWsListener }     from '@twurple/eventsub-ws';
import { WebSocketServer }        from 'ws';

// ——————————————————————————————————————————————————————————
// 0) Пути к файлам и инициализация
const ROOT        = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PARTS_PATH  = path.join(ROOT, 'participants.json');
if (!fs.existsSync(PARTS_PATH)) fs.writeFileSync(PARTS_PATH, '[]', 'utf-8');
let participants = JSON.parse(fs.readFileSync(PARTS_PATH, 'utf-8'));

// ——————————————————————————————————————————————————————————
// 1) Загружаем .env и config.json
const {
  BOT_USERNAME,
  BOT_OAUTH_TOKEN,
  CHANNEL_NAME,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_BROADCASTER_NAME,
  TWITCH_OAUTH_TOKEN,
  TWITCH_REFRESH_TOKEN,
  REWARD_ID,
  REWARD_TITLE   = 'Giveaway',
  PORT           = 8080
} = process.env;

[
  'BOT_USERNAME','BOT_OAUTH_TOKEN','CHANNEL_NAME',
  'TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET',
  'TWITCH_BROADCASTER_NAME',
  'TWITCH_OAUTH_TOKEN','TWITCH_REFRESH_TOKEN',
  'REWARD_ID'
].forEach(k => {
  if (!process.env[k]) {
    console.error(`❌ Missing ${k} in .env`);
    process.exit(1);
  }
});

// Читаем config.json (skins, dropMode, fixedSkin, rarityChances, chatDelay)
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ config.json not found');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
let { skins, dropMode, fixedSkin, rarityChances, chatDelay } = config;

config.chatDelay = config.chatDelay ?? parseInt(CHAT_DELAY, 10);

// ——————————————————————————————————————————————————————————
// 2) Express + JSON + статика
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

// ——————————————————————————————————————————————————————————
// 3) REST API

// GET /get-settings — отдать весь config
app.get('/get-settings', (_req, res) => res.json(config));

// POST /save-settings — сохранить body в config.json
app.post('/save-settings', (req, res) => {
  Object.assign(config, req.body);
  ({ skins, dropMode, fixedSkin, rarityChances, chatDelay } = config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  broadcast({ type: 'settings-updated' });
  console.log('[CONFIG] config.json saved');
  res.json({ message: 'Settings saved' });
});

// Участники
app.get('/participants-count', (_req, res) => res.json({ count: participants.length }));
app.get('/participants.json',     (_req, res) => res.json(participants));

// Загрузка скинов
const IMG_DIR = path.join(ROOT, 'public', 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, IMG_DIR),
    filename:    (_req, file, cb) => {
      const target = path.join(IMG_DIR, file.originalname);
      cb(null, fs.existsSync(target)
        ? file.originalname
        : `${Date.now()}-${file.originalname}`);
    }
  })
});
app.post('/upload-skin', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  res.json({ path: `/img/${req.file.filename}` });
});

// ——————————————————————————————————————————————————————————
// 4) Админ-действия
let collecting = false;
let isOpen     = false;

// Админ-действия из UI
app.post('/start-collection', (_req, res) => {
  collecting = true;
  participants = [];
  fs.writeFileSync(PARTS_PATH, JSON.stringify(participants, null, 2), 'utf-8');
  broadcast({ type:'updateParticipants', participants });
  // ВОТ ЭТА СТРОКА ВОЗВРАЩЕНА:
  chat.say(CHANNEL_NAME,
    `🎉 Giveaway started! Buy a "Galaxy Key" using channel points to enter! 🎉`
  );
  console.log('[ADMIN] start-collection');
  res.json({ success:true });
});


app.post('/open-overlay', (_req, res) => {
  isOpen = true;
  broadcast({ type: 'open' });
  console.log('[ADMIN] open-overlay');
  res.json({ success: true });
});

app.post('/roll', (_req, res) => {
  if (!isOpen)                return res.status(400).json({ error: 'Overlay not open' });
  if (!participants.length)   return res.status(400).json({ error: 'No participants' });

  collecting = false;
  const winner = participants[Math.floor(Math.random() * participants.length)];

  setTimeout(() => {
    chat.say(CHANNEL_NAME,
      `Congratulations @${winner}, you won!`
    );
  }, chatDelay * 1000);

  broadcast({
    type: 'roll',
    winner,
    participants,
    dropMode,
    fixedSkin,
    rarityChances,
    skins
  });

  isOpen = false;
  console.log('[ADMIN] roll, winner=', winner);
  res.json({ success: true, winner });
});

// ——————————————————————————————————————————————————————————
// 5) WebSocket для оверлея
let wss, broadcast;
{
  const server = app.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));
  wss = new WebSocketServer({ server });
  broadcast = msg => {
    wss.clients.forEach(c => {
      if (c.readyState === c.OPEN) c.send(JSON.stringify(msg));
    });
  };
  wss.on('connection', () => console.log('[WS] Overlay connected'));
}

// ——————————————————————————————————————————————————————————
// 6) TMI.js — чат-бот
const chat = new tmi.Client({
  options:    { debug: true },
  connection: { secure: true, reconnect: true },
  identity:   { username: BOT_USERNAME, password: BOT_OAUTH_TOKEN },
  channels:   [ CHANNEL_NAME ]
});
chat.connect()
  .then(() => console.log('[TMI] connected'))
  .catch(err => console.error('[TMI] login failed', err));

chat.on('message', (_ch, tags, msg, self) => {
  if (self || tags.badges?.broadcaster !== '1') return;
  const cmd = msg.trim().toLowerCase();
  if (cmd === '!letsgo') fetch(`http://localhost:${PORT}/start-collection`, { method: 'POST' });
  if (cmd === '!open')   fetch(`http://localhost:${PORT}/open-overlay`,    { method: 'POST' });
  if (cmd === '!roll')   fetch(`http://localhost:${PORT}/roll`,            { method: 'POST' });
});

// ——————————————————————————————————————————————————————————
// 7) EventSub WS — подписка на выкуп вознаграждения
(async() => {
  // 1) Сначала создаём провайдер, но НЕ добавляем токен
  const authProv = new RefreshingAuthProvider(
    { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET },
    {} // пустой, добавим токен чуть позже вместе с userId
  );

  // 2) Создаём API-клиент, находим пользователя по имени
  const api  = new ApiClient({ authProvider: authProv });
  const user = await api.users.getUserByName(TWITCH_BROADCASTER_NAME);
  if (!user) throw new Error('Streamer not found');

  // 3) **Добавляем** токен с указанием userId — иначе подписка не работает
  await authProv.addUserForToken({
    accessToken:  TWITCH_OAUTH_TOKEN,
    refreshToken: TWITCH_REFRESH_TOKEN,
    expiresIn:    0,
    obtainmentTimestamp: Math.floor(Date.now() / 1000),
    userId:       user.id   // <<< вот здесь важно передать userId
  });

  // 4) Теперь подписываемся на EventSub через WS
  const listener = new EventSubWsListener({ authProvider: authProv, apiClient: api });
  listener.onChannelRedemptionAddForReward(
    user.id,
    REWARD_ID,
    event => {
      const disp = event.userDisplayName || event.userName;
      if (!collecting) return;
      if (!participants.includes(disp)) {
        participants.push(disp);
        fs.writeFileSync(PARTS_PATH, JSON.stringify(participants, null, 2), 'utf-8');
        console.log(`➕ Added ${disp}`);
        chat.say(CHANNEL_NAME, `@${disp}, you've entered the giveaway!`);
        broadcast({ type: 'updateParticipants', participants });
      }
    }
  );

  await listener.start();
  console.log(`[EVENTSUB] Listening for "${REWARD_TITLE}" (ID=${REWARD_ID})`);
})();
