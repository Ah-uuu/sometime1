const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const fs = require('fs');
require('dotenv').config(); // 支援環境變數

const server = express();
server.use(cors({ origin: 'https://glittering-bienenstitch-2879d4.netlify.app' })); // 允許 Netlify 來訪問 API
server.use(bodyParser.json());

// Google OAuth 設定
const CLIENT_ID = process.env.CLIENT_ID || '538741165835-a8m93gv79mpbe1kj2vvhejvoejtspndh.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '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';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://somebooking.onrender.com/oauth2callback'; // 這裡之後要改成 Render URL
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const TOKEN_PATH = 'tokens.json';
const CALENDAR_ID = process.env.CALENDAR_ID || 'z033910751@gmail.com';

// 產生 Google OAuth2 登入網址
server.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(authUrl);
});

// 處理 Google OAuth 回調
server.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('缺少授權碼');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('✅ 授權成功！tokens:', tokens);
    res.send('授權成功！請返回應用程式');
  } catch (error) {
    console.error('❌ 交換 token 失敗:', error);
    res.status(500).send('交換 token 失敗');
  }
});

// 載入已存 Token
function loadSavedCredentialsIfExist() {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oauth2Client.setCredentials(tokens);
    console.log('🔄 成功載入 Token');
  } catch (error) {
    console.log('⚠️ 尚未取得 Token，請先授權');
  }
}
loadSavedCredentialsIfExist();

// 刷新 access_token
async function refreshAccessToken() {
  try {
    const tokens = await oauth2Client.getAccessToken();
    oauth2Client.setCredentials({ access_token: tokens.token });
    console.log('🔄 access_token 已更新:', tokens.token);
    
    const savedTokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
    savedTokens.access_token = tokens.token;
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(savedTokens));
  } catch (error) {
    console.error('❌ 刷新 access_token 失敗:', error);
  }
}
setInterval(refreshAccessToken, 50 * 60 * 1000);

// 新增 Google Calendar 預約事件
server.post('/booking', async (req, res) => {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oauth2Client.setCredentials(tokens);

    const { name, phone, service, duration, appointmentTime } = req.body;
    if (!name || !phone || !service || !duration || !appointmentTime) {
      return res.status(400).send('缺少必要的欄位');
    }

    const startTime = new Date(appointmentTime);
    const endTime = new Date(startTime.getTime() + duration * 60000);
    
    const event = {
      summary: `${service} 預約：${name}`,
      description: `電話：${phone}`,
      start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Taipei' },
      end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Taipei' },
    };

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });

    res.status(200).send({ success: true, message: '預約成功！', eventId: response.data.id });
  } catch (error) {
    console.error('❌ 創建事件失敗:', error);
    res.status(500).send({ success: false, message: '創建事件失敗，請稍後再試！' });
  }
});

// 啟動 Express 伺服器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

