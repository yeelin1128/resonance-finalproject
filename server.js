/**
 * 【弦外之境：無線共振】- 後端核心系統 (server.js)
 * 負責處理：
 * 1. Express 靜態網頁路由 (手機端與主視覺端)
 * 2. Socket.io 多人即時連線與資料分發
 * 3. 雙向 OSC 通訊 (送資料給 Pd / 接收 Pd 的吉他演奏動態)
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const dgram = require('dgram');
const path = require('path');

// --- 模式與參數設定 ---
// 在現場筆電運行時，請將 RUN_AS_RECEIVER 設為 true，並填入你部署在雲端的網址
const RUN_AS_RECEIVER = process.env.RUN_AS_RECEIVER === 'true' || false;
const CLOUD_SERVER_URL = process.env.CLOUD_SERVER_URL || 'https://your-render-app.onrender.com'; 

const OSC_TO_PD_PORT = 9001;      // 傳送給 Pd 的 Port (控制 Delay/Reverb/Filter)
const OSC_FROM_PD_PORT = 9002;    // 接收來自 Pd 的 Port (吉他即時音量與悶音)
const OSC_HOST = '127.0.0.1';

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let activeUsers = {};
let guitarState = { env: 0, duration: 0, mute: 0 };

// ==========================================
// 1. 雲端伺服器模式 (網頁託管與 WebSocket 廣播)
// ==========================================

if (!RUN_AS_RECEIVER) {
  console.log("【弦外之境】[雲端伺服器] 正在啟動...");

  // 路由設定：手機操控端
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  // 路由設定：平板/投影主視覺端
  app.get('/vis', (req, res) => {
    res.sendFile(path.join(__dirname, 'vis.html'));
  });

  // 處理觀眾 Socket 連線
  io.on('connection', (socket) => {
    const colors = ['#ff0055', '#00ffcc', '#9900ff', '#ffcc00', '#0099ff'];
    const userColor = colors[Math.floor(Math.random() * colors.length)];
    activeUsers[socket.id] = { id: socket.id, x: 0.5, y: 0.5, color: userColor };

    socket.emit('init', { id: socket.id, color: userColor });
    io.emit('user_joined', { id: socket.id, color: userColor });

    console.log(`觀眾已加入: ${socket.id} (${userColor})`);

    // 接收並更新游標位置
    socket.on('move', (data) => {
      if (activeUsers[socket.id]) {
        activeUsers[socket.id].x = data.x;
        activeUsers[socket.id].y = data.y;
        io.emit('update_users', activeUsers);
      }
    });

    // 接收來自本地接收端轉發的吉他動態，並廣播給所有手機與大螢幕
    socket.on('guitar_input', (data) => {
      guitarState = data;
      io.emit('guitar_update', guitarState);
    });

    socket.on('disconnect', () => {
      console.log(`觀眾已離開: ${socket.id}`);
      delete activeUsers[socket.id];
      io.emit('user_left', socket.id);
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`伺服器正運行於 Port: ${PORT}`);
    console.log(`手機操控端請造訪: http://localhost:${PORT}`);
    console.log(`大螢幕視覺請造訪: http://localhost:${PORT}/vis`);
  });
}

// ==========================================
// 2. 本地接收端模式 (OSC 轉發與吉他特徵接收)
// ==========================================

if (RUN_AS_RECEIVER || process.env.NODE_ENV !== 'production') {
  console.log("【弦外之境】[本地雙向接收器] 正在啟動...");

  const udpSender = dgram.createSocket('udp4');
  const udpReceiver = dgram.createSocket('udp4');
  const ioClient = require('socket.io-client');
  
  // 連線到雲端伺服器 (本機測試預設連 localhost:3000)
  const targetServer = RUN_AS_RECEIVER ? CLOUD_SERVER_URL : 'http://localhost:3000';
  const socketToCloud = ioClient(targetServer);

  socketToCloud.on('connect', () => {
    console.log(`成功串接雲端訊號中樞: ${targetServer}`);
  });

  // A. 【傳出給 Pd】聚合所有觀眾滑動平均值，發送至 Pd (Port 9001)
  socketToCloud.on('update_users', (users) => {
    let totalX = 0, totalY = 0, count = 0;
    for (let id in users) {
      totalX += users[id].x;
      totalY += users[id].y;
      count++;
    }
    if (count > 0) {
      sendOSC('/filter/frequency', totalX / count);
      sendOSC('/granular/size', totalY / count);
      sendOSC('/active/count', count);
    }
  });

  function sendOSC(address, value) {
    const formattedMessage = `${address} ${value};\n`;
    const messageBuffer = Buffer.from(formattedMessage);
    udpSender.send(messageBuffer, 0, messageBuffer.length, OSC_TO_PD_PORT, OSC_HOST);
  }

  // B. 【接收自 Pd】接聽來自 Pd (Port 9002) 的吉他即時演奏特徵
  udpReceiver.on('message', (msg) => {
    const rawStr = msg.toString().trim();
    const commands = rawStr.split(';');
    let hasUpdate = false;

    commands.forEach(cmd => {
      const parts = cmd.trim().split(' ');
      if (parts.length >= 2) {
        const address = parts[0];
        const value = parseFloat(parts[1]);

        if (address === '/guitar/env') {
          guitarState.env = value;
          hasUpdate = true;
        } else if (address === '/guitar/duration') {
          guitarState.duration = value;
          hasUpdate = true;
        } else if (address === '/guitar/mute') {
          guitarState.mute = value;
          hasUpdate = true;
        }
      }
    });

    if (hasUpdate) {
      // 立即將演奏資料推送到雲端，轉發給所有觀眾
      socketToCloud.emit('guitar_input', guitarState);
      
      // 觸發完悶音(mute)後自動歸零，避免持續觸發震動
      if (guitarState.mute > 0) {
        guitarState.mute = 0;
      }
    }
  });

  udpReceiver.bind(OSC_FROM_PD_PORT, () => {
    console.log(`本地 OSC 接收器已就位，正在聆聽 Pd 傳入 (Port ${OSC_FROM_PD_PORT})`);
  });
}