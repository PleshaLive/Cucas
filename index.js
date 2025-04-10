/*************************************************************************
 * index.js — серверная логика (Express + TMI.js + WebSocket)
 *************************************************************************/

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const tmi = require('tmi.js');
const session = require('express-session'); // Для работы с сессиями

// Папка для загрузки файлов (public/img)
const uploadFolder = path.join(__dirname, 'public', 'img');
if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}

// Настраиваем multer для сохранения файлов в public/img
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadFolder);
  },
  filename: (req, file, cb) => {
    const targetPath = path.join(uploadFolder, file.originalname);
    if (fs.existsSync(targetPath)) {
      console.log("File already exists, using existing file:", file.originalname);
      cb(null, file.originalname);
    } else {
      const newName = Date.now() + '-' + file.originalname;
      cb(null, newName);
    }
  }
});
const upload = multer({ storage });

// Загружаем или создаём config.json
const configPath = path.join(__dirname, 'config.json');
let config = {
  BOT_USERNAME: 'Your_Bot_Login',
  BOT_OAUTH: 'oauth:xxxxxx',
  CHANNEL_NAME: 'your_channel',
  chatDelay: 130,
  skins: [],
  dropMode: 'random',
  fixedSkin: null,
  rarityChances: {
    "Mil-Spec": 79.9,
    "Restricted": 16,
    "Classified": 3.2,
    "Covert": 0.64,
    "Rare Special Items": 0.125
  }
};
try {
  const configFile = fs.readFileSync(configPath);
  Object.assign(config, JSON.parse(configFile));
} catch (err) {
  console.log('Не удалось загрузить config.json, используется конфиг по умолчанию.');
}

const app = express();

// Для обработки JSON и данных, отправляемых формой
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Настройка сессий
app.use(session({
  secret: 'mySuperSecretKey', // Замените на безопасное значение или вынесите в переменные окружения
  resave: false,
  saveUninitialized: false
}));

/*************************************************************************
 * Маршруты для аутентификации
 *************************************************************************/

// Отдаем страницу входа (login.html)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Обработка формы логина
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  // Проверка логина и пароля
  if (username === 'StarGalaxy' && password === 'FuckTheWorld1996') {
    req.session.authenticated = true;
    return res.redirect('/settings.html');
  }
  // Если данные неверны, перенаправляем с параметром ошибки (эту логику можно доработать для отображения ошибки)
  return res.redirect('/login?error=1');
});

// Защищенный маршрут для settings.html
app.get('/settings.html', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.sendFile(path.join(__dirname, 'public', 'settings.html'));
  }
  res.redirect('/login');
});

/*************************************************************************
 * Маршруты для получения/сохранения настроек и загрузки файлов
 *************************************************************************/
app.get('/get-settings', (req, res) => {
  res.json(config);
});

app.post('/save-settings', (req, res) => {
  const newConfig = req.body;

  config.BOT_USERNAME = newConfig.BOT_USERNAME || config.BOT_USERNAME;
  config.BOT_OAUTH = newConfig.BOT_OAUTH || config.BOT_OAUTH;
  config.CHANNEL_NAME = newConfig.CHANNEL_NAME || config.CHANNEL_NAME;
  config.chatDelay = newConfig.chatDelay || config.chatDelay;
  if (Array.isArray(newConfig.skins)) {
    config.skins = newConfig.skins;
  }
  config.dropMode = newConfig.dropMode || 'random';
  config.fixedSkin = newConfig.fixedSkin || null;
  config.rarityChances = newConfig.rarityChances || config.rarityChances;

  fs.writeFile(configPath, JSON.stringify(config, null, 2), (err) => {
    if (err) {
      console.error('Ошибка записи config.json:', err);
      return res.status(500).json({ message: 'Ошибка сохранения настроек' });
    }
    res.json({ message: 'Настройки сохранены. Перезапустите сервер для применения изменений.' });

    // Уведомляем всех клиентов WebSocket об обновлении настроек
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'settings-updated' }));
      }
    });
  });
});

app.post('/upload-skin', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }
  const filePath = '/img/' + req.file.filename;
  console.log("File saved (or reused):", filePath);
  res.json({ path: filePath });
});

/*************************************************************************
 * Логика TMI.js (чат-бот) и сбор участников
 *************************************************************************/
const tmiConfig = {
  options: { debug: true },
  connection: { reconnect: true, secure: true },
  identity: {
    username: config.BOT_USERNAME,
    password: config.BOT_OAUTH
  },
  channels: [ config.CHANNEL_NAME ]
};

const client = new tmi.Client(tmiConfig);
let collecting = false;
let participants = [];
let isOpen = false; // Флаг, показывающий, что команда !open уже выполнена

client.on('message', (channel, tags, message, self) => {
  if (self) return;
  const username = tags.username.toLowerCase();
  const msg = message.trim().toLowerCase();

  // Команда !letsgo – запускает сбор участников (только для стримера)
  if (msg === '!letsgo') {
    if (tags.badges && tags.badges.broadcaster === '1') {
      startCollection(); // При новом запуске розыгрыша участники очищаются
    } else {
      client.say(config.CHANNEL_NAME, 'Galaxy runs this madhouse. Don’t fight it - just roll with the trip.');
    }
  }

  // Команда !open – запускает анимацию (только для стримера)
  if (msg === '!open') {
    if (tags.badges && tags.badges.broadcaster === '1') {
      isOpen = true; // Разрешаем выполнение !roll после команды !open
      sendOpenToOverlay();
    }
  }

  // Команда !galaxy для добавления участников во время сбора
  if (collecting && msg === '!galaxy') {
    if (!participants.includes(username)) {
      participants.push(username);
      client.say(config.CHANNEL_NAME, `@${username} You've been thrown into the chaos of fate - welcome to the giveaway, soldier!`);
      sendParticipantsUpdate();
    }
  }

  // Команда !roll для выбора победителя (только для стримера)
  if (msg === '!roll') {
    if (tags.badges && tags.badges.broadcaster === '1') {
      if (!isOpen) {
        client.say(config.CHANNEL_NAME, 'I love you all!');
        return;
      }
      if (participants.length === 0) {
        client.say(config.CHANNEL_NAME, 'HELLO WORLD!');
        return;
      }
      collecting = false;
      const winner = participants[Math.floor(Math.random() * participants.length)];
      const delay = (config.chatDelay || 130) * 1000;
      setTimeout(() => {
        client.say(config.CHANNEL_NAME, `Let's congratulate the winner!`);
      }, delay);
      sendRollToOverlay(winner, participants);
      // После розыгрыша сбрасываем флаг, чтобы !roll не работала до нового !open
      isOpen = false;
    }
  }
});

// Функция сброса списка участников и запуска нового розыгрыша
function startCollection() {
  collecting = true;
  participants = []; // Очищаем старый список
  sendParticipantsUpdate(); // Обновляем клиентов с пустым списком
  client.say(config.CHANNEL_NAME, 'Type !galaxy in chat and claim your prize - if the cosmos deems you worthy.');
}

client.connect().catch(err => {
  console.error('Ошибка подключения к Twitch:', err);
});

/*************************************************************************
 * WebSocket-сервер для оверлея
 *************************************************************************/
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`[SERVER] Запущен на порту ${PORT}`);
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  console.log('[WS] Overlay connected!');
});

function sendOpenToOverlay() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'open' }));
    }
  });
}

function sendParticipantsUpdate() {
  const data = { type: 'updateParticipants', participants };
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function sendRollToOverlay(winner, participantsList) {
  const data = {
    type: 'roll',
    winner,
    participants: participantsList,
    dropMode: config.dropMode
  };
  if (config.dropMode === 'preset' && config.fixedSkin) {
    data.fixedSkin = config.fixedSkin;
  }
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

/*************************************************************************
 * Раздача статических файлов
 * (Эта секция должна быть в самом конце, чтобы не перехватывать
 * маршруты, описанные выше)
 *************************************************************************/
app.use(express.static(path.join(__dirname, 'public')));
