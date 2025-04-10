const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'assets', 'new-icon.ico'), // путь к вашей иконке
    webPreferences: {
      nodeIntegration: false, // отключаем доступ к Node API в окне
    }
  });

  // Загружаем основную страницу из сервера
  mainWindow.loadURL('http://localhost:8080/settings.html');

  // Для отладки можно открыть DevTools (уберите эту строку для финальной сборки)
  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startServer() {
  if (app.isPackaged) {
    // В продакшене приложение упаковано — запускаем сервер через require,
    // чтобы не запускать EXE повторно (иначе spawn вызовет повторный запуск всей сборки)
    console.log('Production mode: запуск сервера через require()');
    require('./index.js');
  } else {
    // В режиме разработки запускаем сервер как дочерний процесс
    console.log('Development mode: запуск серверного процесса через spawn()');
    serverProcess = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      stdio: 'inherit'
    });
    serverProcess.on('close', (code) => {
      console.log(`Сервер завершил работу с кодом ${code}`);
    });
  }
}

app.on('ready', () => {
  startServer();
  // Задержка 3000 мс для гарантии, что сервер успеет запуститься
  setTimeout(createWindow, 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (serverProcess) serverProcess.kill();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
