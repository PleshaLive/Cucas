#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import tmi from 'tmi.js';
import { RefreshingAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws'; // Убедитесь, что этот импорт правильный
import { WebSocketServer } from 'ws';

// ——————————————————————————————————————————————————————————
// 0) Пути к файлам и инициализация
const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PARTS_PATH = path.join(ROOT, 'participants.json');
// +++ Путь к файлу истории победителей +++
const WINNER_HISTORY_PATH = path.join(ROOT, 'winner_history.json');

if (!fs.existsSync(PARTS_PATH)) fs.writeFileSync(PARTS_PATH, '[]', 'utf-8');
let participants = JSON.parse(fs.readFileSync(PARTS_PATH, 'utf-8'));

// +++ Инициализация и загрузка истории победителей +++
if (!fs.existsSync(WINNER_HISTORY_PATH)) {
  fs.writeFileSync(WINNER_HISTORY_PATH, '[]', 'utf-8');
}
let winnerHistory = JSON.parse(fs.readFileSync(WINNER_HISTORY_PATH, 'utf-8'));

let autoRestartTimer = null; // Используем это имя переменной, как в вашем коде

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
  REWARD_TITLE = 'Giveaway',
  PORT = 8080,
  CHAT_DELAY
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

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ config.json not found');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
// Убедимся, что skins, dropMode, fixedSkin, rarityChances, chatDelay извлекаются корректно
// и `fixedSkin` является объектом скина, если он задан, а не просто индексом.
// Это важно для логики истории. Если fixedSkin в config.json это индекс, то нужно будет его разрешить в объект скина.
// Предположим, что `fixedSkin` в `config` уже является объектом скина, если `dropMode === 'preset'`.
let { skins, dropMode, fixedSkin, rarityChances, chatDelay } = config;


config.chatDelay = config.chatDelay ?? (CHAT_DELAY ? parseInt(CHAT_DELAY, 10) : 5);
chatDelay = config.chatDelay;

// ——————————————————————————————————————————————————————————
// +++ ФУНКЦИЯ ДЛЯ ОПРЕДЕЛЕНИЯ СЛУЧАЙНОГО СКИНА +++
function determineRandomlySelectedSkin(availableSkins, chances) {
    if (!availableSkins || availableSkins.length === 0) {
        console.warn("[determineRandomSkin] Нет доступных скинов для выбора.");
        return null;
    }
    if (!chances || Object.keys(chances).length === 0) {
        console.warn("[determineRandomSkin] Шансы редкости не определены. Выбирается случайный скин из всех.");
        return availableSkins[Math.floor(Math.random() * availableSkins.length)];
    }

    const rarityOrder = ["Mil-Spec", "Restricted", "Classified", "Covert", "Rare Special Items"];
    let cumulativeChance = 0;
    const chanceDistribution = [];

    for (const rarity of rarityOrder) {
        const chance = parseFloat(chances[rarity] || 0);
        if (chance > 0) { // Учитываем только редкости с шансом > 0
            cumulativeChance += chance;
            chanceDistribution.push({ rarity, cumulative: cumulativeChance });
        }
    }

    if (cumulativeChance === 0) {
        console.warn("[determineRandomSkin] Сумма всех учитываемых шансов редкости равна нулю. Выбирается случайный скин из всех.");
        return availableSkins[Math.floor(Math.random() * availableSkins.length)];
    }

    const randomPick = Math.random() * cumulativeChance;
    let chosenRarity = null;

    for (const segment of chanceDistribution) {
        if (randomPick < segment.cumulative) {
            chosenRarity = segment.rarity;
            break;
        }
    }
    
    if (!chosenRarity && chanceDistribution.length > 0) { // Фоллбэк, если randomPick был равен cumulativeChance
        chosenRarity = chanceDistribution[chanceDistribution.length - 1].rarity;
    } else if (!chosenRarity && availableSkins.length > 0) {
         console.error("[determineRandomSkin] Не удалось определить редкость по шансам. Выбирается случайный скин из доступных.");
         return availableSkins[Math.floor(Math.random() * availableSkins.length)];
    } else if (!chosenRarity) {
        console.error("[determineRandomSkin] Не удалось определить редкость и нет доступных скинов для фоллбэка по шансам.");
        return null;
    }


    const skinsOfChosenRarity = availableSkins.filter(skin => skin.rarity === chosenRarity);

    if (skinsOfChosenRarity.length > 0) {
        return skinsOfChosenRarity[Math.floor(Math.random() * skinsOfChosenRarity.length)];
    } else {
        console.warn(`[determineRandomSkin] Нет скинов для выбранной по шансам редкости "${chosenRarity}". Попытка найти скин другой существующей редкости.`);
        for (const rarityKey of rarityOrder) { // Ищем в порядке редкости
            const fallbackSkins = availableSkins.filter(s => s.rarity === rarityKey && s !== chosenRarity); // Исключаем уже проверенную редкость, если она была пуста
            if (fallbackSkins.length > 0) {
                console.warn(`[determineRandomSkin] Фоллбэк на редкость "${rarityKey}".`);
                return fallbackSkins[Math.floor(Math.random() * fallbackSkins.length)];
            }
        }
        if (availableSkins.length > 0) { // Если совсем ничего не нашлось по редкостям, но скины есть
             console.warn(`[determineRandomSkin] Не удалось найти скин по редкостям, выбирается случайный из всех доступных.`);
            return availableSkins[Math.floor(Math.random() * availableSkins.length)];
        }
        return null;
    }
}


// ——————————————————————————————————————————————————————————
// 2) Express + JSON + статика
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

// ——————————————————————————————————————————————————————————
// 3) REST API
app.get('/get-settings', (_req, res) => res.json(config));

app.post('/save-settings', (req, res) => {
  Object.assign(config, req.body);
  // Обновляем локальные переменные из config после сохранения
  ({ skins, dropMode, fixedSkin, rarityChances, chatDelay } = config);
  // Важно: если fixedSkin в req.body это индекс (fixedSkinIndex),
  // то нужно преобразовать его в объект скина для переменной fixedSkin
  if (config.dropMode === 'preset' && typeof config.fixedSkinIndex === 'number' && config.skins && config.fixedSkinIndex < config.skins.length) {
      fixedSkin = config.skins[config.fixedSkinIndex];
  } else if (config.dropMode !== 'preset') {
      fixedSkin = null; // Сбрасываем, если не пресет
  }


  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  broadcast({ type: 'settings-updated' });
  console.log('[CONFIG] config.json saved');
  res.json({ message: 'Settings saved' });
});

app.get('/participants-count', (_req, res) => res.json({ count: participants.length }));
app.get('/participants.json', (_req, res) => res.json(participants));

// +++ API для получения истории победителей +++
app.get('/get-winner-history', (_req, res) => {
    res.json(winnerHistory);
});

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

app.get('/get-giveaway-status', (_req, res) => {
    let currentStatusKey = 'status.idle';
    if (collecting) {
        currentStatusKey = 'status.active';
    } else if (autoRestartTimer) { // Используем autoRestartTimer как в вашем коде
        currentStatusKey = 'status.pendingRestart';
    }
    res.json({ active: collecting, statusKey: currentStatusKey });
});

// ——————————————————————————————————————————————————————————
// 4) Админ-действия
let collecting = false;
let isOpen = false;

function startNewCollectionLogic(isAutoRestart = false) { // Переименовано для ясности
    if (autoRestartTimer) {
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
        ? `🎉 The skins giveaway is now live! Spend your reward points to purchase a “Galaxy Key” and take part in the halftime case opening!`
        : `🎉 The skins giveaway has started! Use your reward points to purchase a “Galaxy Key” and join the halftime case opening!`;
    chat.say(CHANNEL_NAME, startMessage);

    console.log(`[ADMIN] start-collection ${isAutoRestart ? '(автоматический перезапуск)' : ''}`);
}

app.post('/start-collection', (_req, res) => {
    startNewCollectionLogic(false);
    res.json({ success:true });
});

app.post('/open-overlay', (_req, res) => {
  isOpen = true;
  broadcast({ type: 'open' });
  console.log('[ADMIN] open-overlay');
  res.json({ success: true });
});

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

    // +++ ОПРЕДЕЛЕНИЕ ВЫИГРАННОГО СКИНА НА СЕРВЕРЕ +++
    let actualWonSkin = null;
    if (dropMode === 'preset' && fixedSkin) { // fixedSkin должен быть объектом скина
        // Убедимся, что fixedSkin (из глобальной переменной, обновляемой из config) это корректный объект
         actualWonSkin = fixedSkin; // Предполагаем, что fixedSkin уже правильный объект скина
    } else if (dropMode === 'random' && skins && skins.length > 0) {
        actualWonSkin = determineRandomlySelectedSkin(skins, rarityChances);
    }

    // Заглушка, если скин не определен, чтобы история записалась
    if (!actualWonSkin) {
        console.log("[ROLL] Не удалось определить конкретный скин. Будет использовано название награды.");
        actualWonSkin = {
            name: REWARD_TITLE,
            weapontype: "Награда", // Тип по умолчанию
            image: null,
            rarity: "Unknown"
        };
    }
    // +++ КОНЕЦ ОПРЕДЕЛЕНИЯ СКИНА +++

    setTimeout(() => {
       const skinNamePart = actualWonSkin.name || REWARD_TITLE;
       let prizeMessageText;

       if (actualWonSkin.weapontype && actualWonSkin.weapontype.trim() !== "") {
           // Если тип оружия существует и не пустой (после удаления пробелов)
           prizeMessageText = `${actualWonSkin.weapontype.trim()}|${skinNamePart}`;
       } else {
           // Если тип оружия отсутствует или пуст, показываем только название скина/награды
           prizeMessageText = skinNamePart;
       }
       chat.say(CHANNEL_NAME, `🎉 Congratulations @${winner}, you’ve won a ${prizeMessageText}!`);
   }, chatDelay * 1000);

    broadcast({
        type: 'roll',
        winner,
        participants,
        dropMode: dropMode,
        selectedSkinToDisplay: actualWonSkin, // Передаем КОНКРЕТНЫЙ скин в оверлей
        // Остальные параметры для возможной совместимости с оверлеем
        fixedSkin: (dropMode === 'preset' ? actualWonSkin : null),
        rarityChances: rarityChances,
        skins: skins
    });
    
    // +++ СОХРАНЕНИЕ В ИСТОРИЮ ПОБЕДИТЕЛЕЙ +++
    const historyEntry = {
        winnerName: winner,
        skinName: actualWonSkin.name,
        skinWeaponType: actualWonSkin.weapontype,
        skinImage: actualWonSkin.image,
        skinRarity: actualWonSkin.rarity,
        timestamp: new Date().toISOString()
    };
    winnerHistory.unshift(historyEntry); // Добавляем в начало массива
    if (winnerHistory.length > 100) { // Ограничиваем размер истории
        winnerHistory.pop();
    }
    fs.writeFileSync(WINNER_HISTORY_PATH, JSON.stringify(winnerHistory, null, 2), 'utf-8');
    console.log(`[HISTORY] Победитель ${winner} выиграл "${actualWonSkin.name}". История сохранена.`);
    // +++ КОНЕЦ СОХРАНЕНИЯ В ИСТОРИЮ +++

    broadcast({ type: 'giveawayStatusUpdate', active: collecting, statusKey: 'status.pendingRestart' });
    console.log('[ADMIN] roll, winner=', winner, 'won skin:', actualWonSkin.name);

    if (autoRestartTimer) { // Используем autoRestartTimer
        clearTimeout(autoRestartTimer);
    }
    autoRestartTimer = setTimeout(() => {
        autoRestartTimer = null;
        console.log('[AUTO-RESTART] Запускается новый розыгрыш через 120 секунд.');
        startNewCollectionLogic(true);
    }, 130000);

    res.json({ success: true, winner, wonSkin: actualWonSkin }); // Возвращаем информацию о выигранном скине
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
    }, ['channel:read:redemptions']);
  } catch (e) {
    console.error('[EventSub] Failed to add user for token:', e);
    process.exit(1);
  }

  const listener = new EventSubWsListener({ apiClient: api });
  
  try {
    await listener.start();
    console.log('[EventSub] Listener started and connected.');

    listener.onRevoke((subscription) => {
        console.error(`[EventSub] Subscription revoked by Twitch for type: ${subscription.type}. ID: ${subscription.id}`);
    });

    try {
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
                    chat.say(CHANNEL_NAME, `@${disp}, you have been added to the giveaway in halftime!`);
                    broadcast({ type: 'updateParticipants', participants });
                } else {
                    console.log(`[EventSub] ${disp} is already in the giveaway "${event.rewardTitle}".`);
                }
            }
        );
        console.log(`[EventSub] Subscribed to redemptions for reward "${REWARD_TITLE}" (ID=${REWARD_ID}) for user ${user.displayName} (ID=${user.id}). Subscription ID: ${redemptionSubscription.id}`);
    } catch (subError) {
        console.error(`[EventSub] Failed to subscribe to ChannelRedemptionAddForReward for reward ${REWARD_ID}:`, subError);
    }

    try {
        const streamOnlineSubscription = await listener.onStreamOnline(user.id, e => {
          console.log(`[EventSub] Stream for ${e.broadcasterDisplayName} is now ONLINE! Event type: ${e.type}`);
        });
        console.log(`[EventSub] Successfully subscribed to Stream Online events for ${user.displayName}. Subscription ID: ${streamOnlineSubscription.id}`);
    } catch (subError) {
        console.error(`[EventSub] Failed to subscribe to StreamOnlineEvents for user ${user.displayName}:`, subError);
    }
    
  } catch (e) {
      console.error('[EventSub] Failed to start listener or critical error in EventSub setup:', e);
      if (e.body) {
        try {
          const errorBody = JSON.parse(e.body);
          console.error('[EventSub] Twitch API error details in body:', JSON.stringify(errorBody, null, 2));
        } catch (parseError) {
          console.error('[EventSub] Twitch API error body (not JSON):', e.body);
        }
      }
  }

})().catch(e => {
    console.error("FATAL Error in EventSub main async execution block:", e);
    process.exit(1);
});