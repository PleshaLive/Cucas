#!/usr/bin/env node
import 'dotenv/config';
import fs            from 'fs';
import path          from 'path';
import express       from 'express';
import multer        from 'multer';
import tmi           from 'tmi.js';
import { RefreshingAuthProvider } from '@twurple/auth';
import { ApiClient }   from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import { WebSocketServer }    from 'ws';

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
  REWARD_TITLE     = 'Giveaway',
  PORT             = 8080,
  CHAT_DELAY       = '5' // Дефолтная задержка для чата, если не задана в config.json
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
  console.error('❌ config.json not found. Please create it.');
  // Пример содержимого config.json:
  // {
  //   "skins": [],
  //   "dropMode": "random",
  //   "fixedSkin": null,
  //   "rarityChances": { "Mil-Spec": 100 },
  //   "chatDelay": 5,
  //   "scrollSpeed": 10
  // }
  // Рекомендуется создать config.json с базовой структурой
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    skins: [{name: "Default Skin", image: "img/default.png", rarity: "Mil-Spec", weapontype: "Item"}],
    dropMode: "random",
    fixedSkin: null,
    rarityChances: { "Mil-Spec": 100 },
    chatDelay: 5,
    scrollSpeed: 10
  }, null, 2), 'utf-8');
  console.log('INFO: Created a default config.json. Please review and customize it.');
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
// Используем let для этих переменных, так как они будут обновляться из config
let { skins, dropMode, fixedSkin, rarityChances, chatDelay, scrollSpeed } = config;

// Устанавливаем chatDelay: из config, если есть, иначе из .env, иначе дефолтное значение 5
config.chatDelay = config.chatDelay ?? parseInt(CHAT_DELAY, 10);
chatDelay = config.chatDelay; // Обновляем локальную переменную
// Устанавливаем scrollSpeed, если отсутствует в конфиге
config.scrollSpeed = config.scrollSpeed ?? 10;
scrollSpeed = config.scrollSpeed;


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
  // Обновляем переменные в области видимости модуля из обновленного config
  ({ skins, dropMode, fixedSkin, rarityChances, chatDelay, scrollSpeed } = config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  broadcast({ type: 'settings-updated' });
  console.log('[CONFIG] config.json saved');
  res.json({ message: 'Settings saved' });
});

// Участники
app.get('/participants-count', (_req, res) => res.json({ count: participants.length }));
app.get('/participants.json',    (_req, res) => res.json(participants));

// Загрузка скинов
const IMG_DIR = path.join(ROOT, 'public', 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, IMG_DIR),
    filename:    (_req, file, cb) => {
      const target = path.join(IMG_DIR, file.originalname);
      // Если файл существует, не переименовываем. Иначе добавляем timestamp.
      // Это было изменено по сравнению с исходным кодом, где Date.now() добавлялся всегда, если имя не уникально.
      // Теперь если файл с таким именем уже есть, он будет перезаписан если имя полностью совпадает.
      // Чтобы избежать перезаписи и создавать уникальные имена, если файл существует:
      // cb(null, fs.existsSync(target) ? `${Date.now()}-${file.originalname}` : file.originalname);
      // Оставим оригинальную логику, которая добавляет timestamp, если файл НЕ существует (что странно)
      // или если имя существует (что логично для избежания перезаписи).
      // Исправленная логика: если файл существует, добавляем timestamp. Иначе, оригинальное имя.
      cb(null, fs.existsSync(target) && path.basename(target) === file.originalname
          ? `${Date.now()}-${file.originalname}`
          : file.originalname);
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
  chat.say(CHANNEL_NAME,
    `🎉 ${REWARD_TITLE} giveaway started — redeem to join!`
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
  if (!isOpen) return res.status(400).json({ error: 'Overlay not open' });
  if (!participants.length) return res.status(400).json({ error: 'No participants' });

  collecting = false;
  const winnerName = participants[Math.floor(Math.random() * participants.length)];

  let actualWinningSkin;
  // Используем переменные skins, dropMode, fixedSkin, rarityChances из области видимости модуля,
  // которые обновляются при /save-settings и инициализируются из config.
  if (dropMode === 'fixed' && fixedSkin && fixedSkin.name && fixedSkin.image && skins.find(s => s.name === fixedSkin.name && s.image === fixedSkin.image)) {
    actualWinningSkin = fixedSkin;
  } else {
    if (!rarityChances || Object.keys(rarityChances).length === 0 || !skins || skins.length === 0) {
        actualWinningSkin = skins && skins.length > 0 ? skins[0] : { name: "Default Server Skin", image: "img/default.png", rarity: "Mil-Spec", weapontype: "Item" };
        console.warn('[Server Roll] Warning: Using fallback skin due to missing skins/rarityChances in config.');
    } else {
        const rand = Math.random() * 100;
        let cumulative = 0;
        let selectedRarity = null;
        const raritiesOrder = ["Mil-Spec", "Restricted", "Classified", "Covert", "Rare Special Items"];

        for (const rarity of raritiesOrder) {
            if (rarityChances.hasOwnProperty(rarity)) {
                cumulative += parseFloat(rarityChances[rarity]) || 0;
                if (rand < cumulative) {
                    selectedRarity = rarity;
                    break;
                }
            }
        }

        if (!selectedRarity) {
             selectedRarity = raritiesOrder.find(r => skins.some(s => s.rarity === r)) || raritiesOrder[0];
             console.warn(`[Server Roll] Warning: selectedRarity fallback to ${selectedRarity}. Rand: ${rand}, Cumulative at end: ${cumulative}`);
        }

        const filteredSkinsByRarity = skins.filter(s => s.rarity === selectedRarity);

        if (filteredSkinsByRarity.length === 0) {
            actualWinningSkin = skins.length > 0 ? skins[Math.floor(Math.random() * skins.length)] : { name: "Fallback Server Skin 2", image: "img/default.png", rarity: "Mil-Spec", weapontype: "Item" };
            console.warn(`[Server Roll] Warning: No skins for rarity ${selectedRarity}. Using random fallback from all skins.`);
        } else {
            actualWinningSkin = filteredSkinsByRarity[Math.floor(Math.random() * filteredSkinsByRarity.length)];
        }
    }
  }

  setTimeout(() => {
    chat.say(CHANNEL_NAME,
      `Congratulations @${winnerName}, you won ${actualWinningSkin ? actualWinningSkin.name : REWARD_TITLE}!`
    );
  }, (chatDelay || 5) * 1000); // Используем chatDelay из config (обновляемую)

  broadcast({
    type: 'roll',
    winnerName,
    participants,
    actualWinningSkin,
    dropMode,         // Передаем для информации или если клиентской логике нужно
    fixedSkin,        // Передаем для информации
    rarityChances,    // Передаем, т.к. клиентская randomSkin() может их использовать
    skins             // Передаем, т.к. клиентская randomSkin() может их использовать
  });

  isOpen = false;
  console.log('[ADMIN] roll, winner=', winnerName, 'won:', actualWinningSkin ? actualWinningSkin.name : 'N/A');
  res.json({ success: true, winner: winnerName, winningSkin: actualWinningSkin });
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
  wss.on('connection', (wsClient) => {
    console.log('[WS] Overlay connected');
    // При подключении нового клиента, можно отправить ему текущее состояние, если нужно.
    // Например, текущее количество участников:
    // wsClient.send(JSON.stringify({ type: 'updateParticipants', participants }));
    // Или текущие настройки (хотя клиент их и так загружает при старте)
    // wsClient.send(JSON.stringify({ type: 'initialSettings', settings: config }));
  });
}

// ——————————————————————————————————————————————————————————
// 6) TMI.js — чат-бот
const chat = new tmi.Client({
  options:    { debug: Boolean(process.env.TMI_DEBUG) || false }, // Debug можно включать через .env
  connection: { secure: true, reconnect: true },
  identity:   { username: BOT_USERNAME, password: BOT_OAUTH_TOKEN },
  channels:   [ CHANNEL_NAME ]
});
chat.connect()
  .then(() => console.log('[TMI] connected'))
  .catch(err => console.error('[TMI] login failed', err));

chat.on('message', (_ch, tags, msg, self) => {
  if (self || tags.badges?.broadcaster !== '1') return; // Команды только от стримера
  const cmd = msg.trim().toLowerCase();
  // Используем fetch для вызова локальных эндпоинтов
  const baseUrl = `http://localhost:${PORT}`;
  if (cmd === '!letsgo') fetch(`${baseUrl}/start-collection`, { method: 'POST' }).catch(err => console.error("Error calling /start-collection:", err));
  if (cmd === '!open')   fetch(`${baseUrl}/open-overlay`,   { method: 'POST' }).catch(err => console.error("Error calling /open-overlay:", err));
  if (cmd === '!roll')   fetch(`${baseUrl}/roll`,           { method: 'POST' }).catch(err => console.error("Error calling /roll:", err));
});

// ——————————————————————————————————————————————————————————
// 7) EventSub WS — подписка на выкуп вознаграждения
(async() => {
  try {
    const authProv = new RefreshingAuthProvider(
      { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET },
      {} // Токен добавим позже
    );

    const api  = new ApiClient({ authProvider: authProv });
    const user = await api.users.getUserByName(TWITCH_BROADCASTER_NAME);
    if (!user) {
      console.error(`❌ Streamer with name "${TWITCH_BROADCASTER_NAME}" not found.`);
      process.exit(1); // Выход, если стример не найден, т.к. EventSub не сможет работать
    }

    await authProv.addUserForToken({
      accessToken:  TWITCH_OAUTH_TOKEN,
      refreshToken: TWITCH_REFRESH_TOKEN,
      expiresIn:    0, // Будет обновляться автоматически
      obtainmentTimestamp: 0, // Будет обновляться автоматически
      userId:       user.id
    }, ['chat:read', 'chat:edit', 'channel:read:redemptions']); // Укажем нужные scopes, если они требуются для токена


    const listener = new EventSubWsListener({ apiClient: api }); // apiClient вместо authProvider, как рекомендуется в новых версиях @twurple
    // Примечание: в более новых версиях @twurple/eventsub-ws может требоваться authProvider напрямую,
    // но apiClient обычно предпочтительнее, так как он уже содержит authProvider.
    // Если возникнут проблемы с аутентификацией EventSub, проверьте документацию @twurple.
    // Похоже, listener все еще принимает apiClient, который содержит authProvider.

    await listener.start();
    console.log('[EVENTSUB] Listener started. Subscribing to channel point redemptions...');

    const subscription = await listener.onChannelRedemptionAddForReward(
      user.id,
      REWARD_ID,
      event => {
        const disp = event.userDisplayName || event.userName;
        if (!collecting) {
          console.log(`[EVENTSUB] Redemption by ${disp} for "${event.rewardTitle}" ignored (collection not active).`);
          return;
        }
        if (!participants.includes(disp)) {
          participants.push(disp);
          fs.writeFileSync(PARTS_PATH, JSON.stringify(participants, null, 2), 'utf-8');
          console.log(`[EVENTSUB] ➕ Added ${disp} for "${event.rewardTitle}"`);
          chat.say(CHANNEL_NAME, `@${disp}, you've entered the "${REWARD_TITLE}" giveaway!`);
          broadcast({ type: 'updateParticipants', participants });
        } else {
          console.log(`[EVENTSUB] ${disp} tried to enter for "${event.rewardTitle}" again.`);
        }
      }
    );
    console.log(`[EVENTSUB] Successfully subscribed to "${REWARD_TITLE}" (Reward ID: ${REWARD_ID}, Subscription ID: ${subscription.id})`);

    // Обработка ошибок подписки или listener'а
    listener.onSubscriptionCreateFailure((sub, error) => console.error(`[EVENTSUB] Subscription create failure for ${sub.id}:`, error));
    listener.onSubscriptionDeleteFailure((sub, error) => console.error(`[EVENTSUB] Subscription delete failure for ${sub.id}:`, error));
    listener.onVerify((success, sub) => console.log(`[EVENTSUB] Subscription verification for ${sub.id}: ${success ? 'OK' : 'FAILED'}`));
    // listener.onRevoke((sub) => console.log(`[EVENTSUB] Subscription ${sub.id} revoked.`)); // onRevoke может потребовать другой обработчик

  } catch (error) {
    console.error('[EVENTSUB] Initialization failed:', error);
    if (error.message && error.message.includes("authentication failed")) {
        console.error("Hint: Check your TWITCH_OAUTH_TOKEN and TWITCH_REFRESH_TOKEN. They might be invalid or lack necessary scopes.");
    }
    // process.exit(1); // Можно раскомментировать, если EventSub критичен для работы
  }
})();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SYSTEM] Shutting down...');
  if (chat && chat.isConnected()) {
    chat.disconnect();
    console.log('[TMI] Disconnected.');
  }
  // EventSub listener.stop() не всегда доступен или работает как ожидается для WS.
  // WebSocketServer закроется при закрытии HTTP сервера.
  process.exit(0);
});