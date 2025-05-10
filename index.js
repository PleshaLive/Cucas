#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import tmi from 'tmi.js';
import { RefreshingAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import { WebSocketServer } from 'ws';

// ——————————————————————————————————————————————————————————
// 0) Пути к файлам и инициализация
const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PARTS_PATH = path.join(ROOT, 'participants.json');
if (!fs.existsSync(PARTS_PATH)) fs.writeFileSync(PARTS_PATH, '[]', 'utf-8');
let participants = JSON.parse(fs.readFileSync(PARTS_PATH, 'utf-8'));

// НОВАЯ ГЛОБАЛЬНАЯ ПЕРЕМЕННАЯ для таймера
let autoRestartTimer = null;

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
  REWARD_TITLE = 'Giveaway', // REWARD_TITLE используется в сообщениях
  PORT = 8080,
  CHAT_DELAY // CHAT_DELAY из .env, если есть
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
let { skins, dropMode, fixedSkin, rarityChances, chatDelay } = config; // chatDelay из config

// Устанавливаем chatDelay: приоритет у config.json, потом .env, потом дефолтное значение (если нужно)
config.chatDelay = config.chatDelay ?? (CHAT_DELAY ? parseInt(CHAT_DELAY, 10) : 5); // Пример дефолта 5 сек, если нигде не указано
chatDelay = config.chatDelay; // Обновляем локальную переменную

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
  ({ skins, dropMode, fixedSkin, rarityChances, chatDelay } = config); // Обновляем переменные из config
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  broadcast({ type: 'settings-updated' }); // Уведомляем клиентов об обновлении настроек
  console.log('[CONFIG] config.json saved');
  res.json({ message: 'Settings saved' });
});

// Участники
app.get('/participants-count', (_req, res) => res.json({ count: participants.length }));
app.get('/participants.json', (_req, res) => res.json(participants));

// Загрузка скинов
const IMG_DIR = path.join(ROOT, 'public', 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, IMG_DIR),
    filename: (_req, file, cb) => {
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

// НОВЫЙ ЭНДПОИНТ для получения статуса розыгрыша
app.get('/get-giveaway-status', (_req, res) => {
    let currentStatusKey = 'status.idle';
    if (collecting) { // 'collecting' - наша основная переменная состояния
        currentStatusKey = 'status.active';
    } else if (autoRestartTimer) { // Если сбор не идет, но таймер активен
        currentStatusKey = 'status.pendingRestart';
    }
    res.json({ active: collecting, statusKey: currentStatusKey });
});

// ——————————————————————————————————————————————————————————
// 4) Админ-действия
let collecting = false; // Определяет, идет ли сбор участников
let isOpen = false;     // Определяет, открыт ли оверлей для анимации

// НОВАЯ/ОБНОВЛЕННАЯ ФУНКЦИЯ для начала сбора участников
function startNewCollectionLogic(isAutoRestart = false) {
    if (autoRestartTimer) { // Если был запланирован перезапуск
        clearTimeout(autoRestartTimer);
        autoRestartTimer = null;
        console.log('[AUTO-RESTART] Таймер перезапуска очищен.');
    }

    collecting = true;
    participants = [];
    fs.writeFileSync(PARTS_PATH, JSON.stringify(participants, null, 2), 'utf-8');
    broadcast({ type: 'updateParticipants', participants });
    broadcast({ type: 'giveawayStatusUpdate', active: collecting, statusKey: 'status.active' });

    const startMessage = isAutoRestart
        ? `🎉 Новый розыгрыш запущен автоматически! Покупайте "${REWARD_TITLE}" за очки канала!`
        : `🎉 Розыгрыш "${REWARD_TITLE}" запущен! Покупайте награду за очки канала!`;
    chat.say(CHANNEL_NAME, startMessage);

    console.log(`[ADMIN] start-collection ${isAutoRestart ? '(автоматический перезапуск)' : ''}`);
}

// ОБНОВЛЕНО: Используем startNewCollectionLogic
app.post('/start-collection', (_req, res) => {
    startNewCollectionLogic(false); // false - не автоматический перезапуск
    res.json({ success:true });
});

app.post('/open-overlay', (_req, res) => {
  isOpen = true;
  broadcast({ type: 'open' });
  console.log('[ADMIN] open-overlay');
  res.json({ success: true });
});

// ОБНОВЛЕНО: Логика для /roll с автоперезапуском и статусами
app.post('/roll', (_req, res) => {
    if (!isOpen) {
        return res.status(400).json({ error: 'Overlay not open' });
    }

    collecting = false;
    isOpen = false;

    if (!participants.length) {
        broadcast({ type: 'giveawayStatusUpdate', active: collecting, statusKey: 'status.idle' });
        console.log('[ADMIN] roll failed - no participants');
        return res.status(400).json({ error: 'No participants' });
    }

    const winner = participants[Math.floor(Math.random() * participants.length)];

    setTimeout(() => {
        chat.say(CHANNEL_NAME, `🎉 Поздравляем @${winner}, вы выиграли ${REWARD_TITLE}!`);
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

    broadcast({ type: 'giveawayStatusUpdate', active: collecting, statusKey: 'status.pendingRestart' });
    console.log('[ADMIN] roll, winner=', winner);

    if (autoRestartTimer) {
        clearTimeout(autoRestartTimer);
    }
    autoRestartTimer = setTimeout(() => {
        autoRestartTimer = null;
        console.log('[AUTO-RESTART] Запускается новый розыгрыш через 120 секунд.');
        startNewCollectionLogic(true);
    }, 120000);

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
  wss.on('connection', (wsClient) => {
    console.log('[WS] Overlay or Settings page connected');
    let initialStatusKey = 'status.idle';
    if (collecting) {
        initialStatusKey = 'status.active';
    } else if (autoRestartTimer) {
        initialStatusKey = 'status.pendingRestart';
    }
    if (wsClient.readyState === wsClient.OPEN) {
        wsClient.send(JSON.stringify({ type: 'giveawayStatusUpdate', active: collecting, statusKey: initialStatusKey }));
        wsClient.send(JSON.stringify({ type: 'updateParticipants', participants: participants }));
    }
  });
}

// ——————————————————————————————————————————————————————————
// 6) TMI.js — чат-бот
const chat = new tmi.Client({
  options: { debug: false },
  connection: { secure: true, reconnect: true },
  identity: { username: BOT_USERNAME, password: BOT_OAUTH_TOKEN },
  channels: [ CHANNEL_NAME ]
});
chat.connect()
  .then(() => console.log('[TMI] connected'))
  .catch(err => console.error('[TMI] login failed', err));

chat.on('message', (_ch, tags, msg, self) => {
  if (self || !tags.badges || tags.badges.broadcaster !== '1') return;
  const cmd = msg.trim().toLowerCase();
  const baseUrl = `http://localhost:${PORT}`;
  if (cmd === '!letsgo' || cmd === '!start') fetch(`${baseUrl}/start-collection`, { method: 'POST' }).catch(err => console.error("Error calling /start-collection:", err));
  if (cmd === '!open')   fetch(`${baseUrl}/open-overlay`,   { method: 'POST' }).catch(err => console.error("Error calling /open-overlay:", err));
  if (cmd === '!roll')   fetch(`${baseUrl}/roll`,           { method: 'POST' }).catch(err => console.error("Error calling /roll:", err));
});

// ——————————————————————————————————————————————————————————
// 7) EventSub WS — подписка на выкуп вознаграждения
(async() => {
  const authProv = new RefreshingAuthProvider(
    { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET },
    {}
  );

  const api = new ApiClient({ authProvider: authProv });
  const user = await api.users.getUserByName(TWITCH_BROADCASTER_NAME);
  if (!user) {
      console.error(`[EventSub] Streamer "${TWITCH_BROADCASTER_NAME}" not found.`);
      process.exit(1);
  }

  try {
    await authProv.addUserForToken({
        accessToken: TWITCH_OAUTH_TOKEN,
        refreshToken: TWITCH_REFRESH_TOKEN,
        expiresIn: 0,
        obtainmentTimestamp: Date.now() - 1000*60*5,
    }, ['chat:read', 'chat:edit', 'channel:read:redemptions']);
  } catch (e) {
    console.error('[EventSub] Failed to add user for token:', e);
    process.exit(1);
  }

  const listener = new EventSubWsListener({ apiClient: api });
  
  try {
    await listener.start();
    console.log('[EventSub] Listener started.');

    const redemptionSubscription = await listener.onChannelRedemptionAddForReward(
        user.id,
        REWARD_ID,
        event => {
            const disp = event.userDisplayName || event.userName;
            if (!collecting) {
                console.log(`[EventSub] Received redemption from ${disp} for "${event.rewardTitle}", but collection is not active.`);
                return;
            }
            if (!participants.includes(disp)) {
                participants.push(disp);
                fs.writeFileSync(PARTS_PATH, JSON.stringify(participants, null, 2), 'utf-8');
                console.log(`[EventSub] ➕ Added ${disp} to participants for "${event.rewardTitle}". Current count: ${participants.length}`);
                chat.say(CHANNEL_NAME, `@${disp}, вы добавлены в розыгрыш "${REWARD_TITLE}"!`);
                broadcast({ type: 'updateParticipants', participants });
            } else {
                console.log(`[EventSub] ${disp} is already in the giveaway "${event.rewardTitle}".`);
            }
        }
    );
    console.log(`[EventSub] Subscribed to redemptions for reward "${REWARD_TITLE}" (ID=${REWARD_ID}) for user ${user.displayName} (ID=${user.id})`);

    // ИСПРАВЛЕННЫЕ ОБРАБОТЧИКИ СОСТОЯНИЯ ПОДПИСОК С ТОЧКАМИ С ЗАПЯТОЙ И КОРРЕКТНЫМИ ПАРАМЕТРАМИ/СВОЙСТВАМИ
    listener.onSubscriptionCreateFailure((subscriptionAttempt, error) => {
        // subscriptionAttempt - это объект подписки, который не удалось создать.
        // error - объект ошибки.
        console.error(`[EventSub] Subscription creation failed. Error: ${error.message}.`, error, subscriptionAttempt);
    }); // Точка с запятой

    listener.onVerify((success, subscription) => {
        // success - boolean, true если верификация успешна.
        // subscription - объект EventSubSubscription.
        console.log(`[EventSub] Subscription ${success ? 'verified' : 'verification failed'} for type: ${subscription.type}. ID: ${subscription.id}`);
    }); // Точка с запятой

    listener.onRevoke((subscription) => {
        // subscription - объект EventSubSubscription, который был отозван.
        console.error(`[EventSub] Subscription revoked for type: ${subscription.type}. ID: ${subscription.id}`);
    }); // Точка с запятой

    // Корректная подписка на событие выхода в онлайн
    const streamOnlineSubscription = await listener.onStreamOnline(user.id, e => {
      console.log(`[EventSub] Stream for ${e.broadcasterDisplayName} is now ONLINE! Event type: ${e.type}`);
    });
    console.log(`[EventSub] Successfully subscribed to Stream Online events for ${user.displayName}. ID подписки: ${streamOnlineSubscription.id}`);
    // Удалена дублирующая строка: await listener.subscribeToStreamOnlineEvents(user.id);

  } catch (e) {
      console.error('[EventSub] Failed to start listener or subscribe to events:', e);
      if (e.body) {
        try {
          const errorBody = JSON.parse(e.body);
          console.error('[EventSub] Twitch API error details:', JSON.stringify(errorBody, null, 2));
        } catch (parseError) {
          console.error('[EventSub] Twitch API error body (not JSON):', e.body);
        }
      }
      process.exit(1); // Рассмотрите, нужно ли здесь завершать процесс
  }

})().catch(e => {
    console.error("Error in EventSub async block:", e);
    // process.exit(1);
});