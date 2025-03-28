const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const fetch = require('node-fetch');
require('dotenv').config();

const server = express();
server.use(cors({ origin: 'https://booking-sometime-0.onrender.com' }));
server.use(bodyParser.json());

// 環境變數設置
const CALENDAR_ID = process.env.CALENDAR_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SERVICE_ACCOUNT_JSON || !CALENDAR_ID || !SPREADSHEET_ID) {
  console.error('❌ 環境變數缺失：');
  if (!SERVICE_ACCOUNT_JSON) console.error('  - GOOGLE_SERVICE_ACCOUNT_JSON 未設置');
  if (!CALENDAR_ID) console.error('  - CALENDAR_ID 未設置');
  if (!SPREADSHEET_ID) console.error('  - SPREADSHEET_ID 未設置');
  process.exit(1);
}

let auth;
try {
  const serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
} catch (error) {
  console.error('❌ 解析 Service Account JSON 失敗:', error.message);
  process.exit(1);
}

const calendar = google.calendar({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

// 服務配置
const SERVICES = {
  '半身按摩_30': { maxCapacity: 3, resource: 'body', duration: 30 },
  '半身按摩_60': { maxCapacity: 3, resource: 'body', duration: 60 },
  '全身按摩_60': { maxCapacity: 3, resource: 'body', duration: 60 },
  '全身按摩_90': { maxCapacity: 3, resource: 'body', duration: 90 },
  '全身按摩_120': { maxCapacity: 3, resource: 'body', duration: 120 },
  '全身按摩_150': { maxCapacity: 3, resource: 'body', duration: 150 },
  '腳底按摩_40': { maxCapacity: 2, resource: 'foot', duration: 40 },
  '腳底按摩_70': { maxCapacity: 2, resource: 'foot', duration: 70 },
  '腳底+半身_70': { maxCapacity: 2, resource: ['foot', 'body'], duration: 70, components: ['腳底按摩', '半身按摩'] },
  '腳底+全身_100': { maxCapacity: 2, resource: ['foot', 'body'], duration: 100, components: ['腳底按摩', '全身按摩'] },
  '腳底+全身_130': { maxCapacity: 2, resource: ['foot', 'body'], duration: 130, components: ['腳底按摩', '全身按摩'] },
};

// 資源容量
const RESOURCE_CAPACITY = {
  'body': 3,
  'foot': 2,
};

// 師傅與顏色的映射
const MASTER_COLORS_ENV = process.env.MASTER_COLORS;
let MASTER_COLORS = {};
try {
  if (MASTER_COLORS_ENV) {
    MASTER_COLORS = JSON.parse(MASTER_COLORS_ENV);
  } else {
    MASTER_COLORS = {
      '阿U 1號': '10',
      '小周 2號': '3',
      'Alan 7號': '6',
      'Vincent 8號': '8',
      '楊 9號': '2',
      '魚丸 12號': '7',
      'Flame 24號': '4',
      '小力 30號': '9',
      '': '5',
    };
  }
} catch (error) {
  console.error('❌ 解析 MASTER_COLORS 環境變數失敗:', error.message);
  MASTER_COLORS = {
    '阿U 1號': '10',
    '小周 2號': '3',
    'Alan 7號': '6',
    'Vincent 8號': '8',
    '楊 9號': '2',
    '魚丸 12號': '7',
    'Flame 24號': '4',
    '小力 30號': '9',
    '': '5',
  };
}

// 營業時間
const BUSINESS_HOURS = {
  1: { start: 12, end: 22 },
  2: { start: 12, end: 22 },
  3: { start: 12, end: 22 },
  4: { start: 12, end: 22 },
  5: { start: 13, end: 23 },
  6: { start: 13, end: 23 },
  0: { start: 13, end: 23 },
};

// 健康檢查 API
server.get('/health', (req, res) => {
  const source = req.headers['user-agent'] || '未知來源';
  console.log(`✅ /health API 被呼叫於 ${new Date().toISOString()}，來源: ${source}`);
  res.send('✅ Server is running');
});

// Keep-Alive PING
const keepAlive = () => {
  console.log(`🔄 嘗試 PING /health API 以保持活躍於 ${new Date().toISOString()}...`);
  fetch('https://booking-k1q8.onrender.com/health', { method: 'GET' })
    .then(res => res.text())
    .then(data => console.log(`✅ Keep-alive ping 成功於 ${new Date().toISOString()}: ${data}`))
    .catch(err => console.error(`❌ Keep-alive ping 失敗於 ${new Date().toISOString()}:`, err));
};
setInterval(keepAlive, 600000);

// 檢查營業時間
function checkBusinessHours(appointmentTime, duration) {
  const momentTime = moment.tz(appointmentTime, 'Asia/Taipei');
  const dayOfWeek = momentTime.day();
  const hour = momentTime.hour();
  const endTime = momentTime.clone().add(duration, 'minutes');
  const endHour = endTime.hour();

  const { start, end } = BUSINESS_HOURS[dayOfWeek];
  
  if (hour < start || endHour > end) {
    return { isValid: false, message: '請預約營業時間內（週一到週四 12:00~22:00，週五到週日 13:00~23:00）' };
  }
  return { isValid: true };
}

// 查找指定日期的最快可用時段（支援多人）
async function findNextAvailableTime(services, targetDate) {
  if (!services || services.length === 0) return null;

  const maxDuration = Math.max(...services.map(service => SERVICES[service]?.duration || 0));
  const today = targetDate.clone().startOf('day');
  const searchEnd = targetDate.clone().endOf('day');
  const now = moment.tz('Asia/Taipei');

  let currentTime = today.clone().isBefore(now) ? now.clone() : today.clone();
  if (currentTime.minute() % 5 !== 0) {
    currentTime.add(5 - (currentTime.minute() % 5), 'minutes');
  }

  while (currentTime.isBefore(searchEnd)) {
    const checkStart = currentTime.clone().toISOString();
    const checkEnd = currentTime.clone().add(maxDuration, 'minutes').toISOString();

    const businessCheck = checkBusinessHours(checkStart, maxDuration);
    if (!businessCheck.isValid) {
      currentTime.add(5, 'minutes');
      continue;
    }

    const resourceAvailability = await checkResourceAvailabilityForMultiple(services, checkStart, checkEnd);
    if (resourceAvailability.isAvailable) {
      return checkStart;
    }

    currentTime.add(5, 'minutes');
  }

  return null;
}

// 檢查資源可用性（支援多人）
async function checkResourceAvailabilityForMultiple(services, startTime, endTime) {
  try {
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startTime,
      timeMax: endTime,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    const resourceUsage = { body: 0, foot: 0 };

    // 計算現有事件的資源使用量
    for (const event of events) {
      if (!event.summary || typeof event.summary !== 'string') {
        console.warn(`⚠️ 事件 ${event.id} 缺少 summary，跳過該事件`);
        continue;
      }
      const eventService = event.summary.split(' 預約：')[0];
      if (!SERVICES[eventService]) continue;
      const eventResource = Array.isArray(SERVICES[eventService].resource)
        ? SERVICES[eventService].resource
        : [SERVICES[eventService].resource];
      eventResource.forEach(res => {
        resourceUsage[res]++;
      });
    }

    // 計算新預約的資源需求
    const newResourceUsage = { body: 0, foot: 0 };
    for (const service of services) {
      const serviceConfig = SERVICES[service];
      if (!serviceConfig) continue;
      const resources = Array.isArray(serviceConfig.resource)
        ? serviceConfig.resource
        : [serviceConfig.resource];
      resources.forEach(res => {
        newResourceUsage[res]++;
      });
    }

    // 檢查總資源使用量是否超過容量
    for (const res in newResourceUsage) {
      const totalUsage = resourceUsage[res] + newResourceUsage[res];
      if (totalUsage > RESOURCE_CAPACITY[res]) {
        return { isAvailable: false };
      }
    }

    return { isAvailable: true };
  } catch (error) {
    console.error('❌ 檢查資源可用性失敗:', error.message);
    throw error;
  }
}

// 檢查資源可用性（單人）
async function checkResourceAvailability(service, startTime, endTime) {
  const serviceConfig = SERVICES[service];
  const components = serviceConfig.components || [service];

  try {
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startTime,
      timeMax: endTime,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    for (const comp of components) {
      const resource = Array.isArray(SERVICES[comp].resource) ? SERVICES[comp].resource : [SERVICES[comp].resource];
      for (const res of resource) {
        const maxCapacity = RESOURCE_CAPACITY[res];
        const serviceEvents = events.filter(event => {
          if (!event.summary || typeof event.summary !== 'string') {
            console.warn(`⚠️ 事件 ${(event.id || '未知事件')} 缺少 summary，跳過該事件`);
            return false;
          }
          const eventService = event.summary.split(' 預約：')[0];
          if (!SERVICES[eventService]) return false;
          const eventResource = Array.isArray(SERVICES[eventService].resource) ? SERVICES[eventService].resource : [SERVICES[eventService].resource];
          return eventResource.includes(res);
        });

        const overlappingEvents = serviceEvents.filter(event => {
          const eventStart = moment.tz(event.start.dateTime || event.start.date, 'Asia/Taipei');
          const eventEnd = moment.tz(event.end.dateTime || event.end.date, 'Asia/Taipei');
          const checkStartMoment = moment.tz(startTime, 'Asia/Taipei');
          const checkEndMoment = moment.tz(endTime, 'Asia/Taipei');

          return eventStart.isBefore(checkEndMoment) && eventEnd.isAfter(checkStartMoment) &&
                 !(eventEnd.isSameOrBefore(checkStartMoment));
        });

        if (overlappingEvents.length >= maxCapacity) {
          return { isAvailable: false };
        }
      }
    }

    return { isAvailable: true };
  } catch (error) {
    console.error('❌ 檢查資源可用性失敗:', error.message);
    throw error;
  }
}

// 檢查師傅可用性（改用 colorId 檢查）
async function checkTherapistAvailability(master, startTime, endTime) {
  try {
    const masterColorId = MASTER_COLORS[master];
    if (!masterColorId) {
      console.error(`❌ 師傅 ${master} 在 MASTER_COLORS 中未定義 colorId`);
      return { isAvailable: false, message: `師傅 ${master} 未定義顏色，請聯繫管理員` };
    }

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startTime,
      timeMax: endTime,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    const masterEvents = events.filter(event => event.colorId === masterColorId);

    console.log(`檢查師傅 ${master} (${masterColorId}) 在 ${startTime} 至 ${endTime} 的可用性：${masterEvents.length === 0 ? '可用' : '已被占用'}`);
    return { isAvailable: masterEvents.length === 0 };
  } catch (error) {
    console.error('❌ 檢查師傅可用性失敗:', error.message);
    throw error;
  }
}

// 檢查預約時段（支援多人）
async function checkAvailability(guests, startTime, endTime) {
  const services = guests.map(guest => guest.service);
  const masters = guests.map(guest => guest.master).filter(master => master);

  for (const service of services) {
    if (!SERVICES[service]) {
      return { isAvailable: false, message: `無效的服務類型: ${service}` };
    }
  }

  const now = moment.tz('Asia/Taipei');
  if (moment.tz(startTime, 'Asia/Taipei').isBefore(now)) {
    return { isAvailable: false, message: '無法預約過去的時間，請選擇未來時段' };
  }

  const maxDuration = Math.max(...services.map(service => SERVICES[service].duration));
  const businessCheck = checkBusinessHours(startTime, maxDuration);
  if (!businessCheck.isValid) {
    return { isAvailable: false, message: businessCheck.message + '，請點擊「當日可預約時段」查看可用時間' };
  }

  const resourceAvailability = await checkResourceAvailabilityForMultiple(services, startTime, endTime);
  if (!resourceAvailability.isAvailable) {
    return {
      isAvailable: false,
      message: '該時段場地容量不足，無法容納所有顧客，請點擊「當日可預約時段」查看可用時間\n該店最大同時容客量 3位身體 2位腳底',
    };
  }

  for (const guest of guests) {
    if (guest.master) {
      const serviceConfig = SERVICES[guest.service];
      const guestEndTime = moment.tz(startTime, 'Asia/Taipei').add(serviceConfig.duration, 'minutes').toISOString();
      const therapistAvailability = await checkTherapistAvailability(guest.master, startTime, guestEndTime);
      if (!therapistAvailability.isAvailable) {
        return {
          isAvailable: false,
          message: `師傅 ${guest.master} 在該時段已有預約，請選擇其他師傅或點擊「當日可預約時段」查看可用時間`,
        };
      }
    }
  }

  return { isAvailable: true };
}

// 查詢指定日期最快可預約時段 API（支援多人）
server.get('/available-times', async (req, res) => {
  try {
    const { services, date } = req.query;
    if (!services) {
      return res.status(400).send({ success: false, message: '缺少服務類型' });
    }

    let parsedServices;
    try {
      parsedServices = JSON.parse(services);
    } catch (error) {
      return res.status(400).send({ success: false, message: '服務類型格式錯誤' });
    }

    for (const service of parsedServices) {
      if (!SERVICES[service]) {
        return res.status(400).send({ success: false, message: `無效的服務類型: ${service}` });
      }
    }

    const targetDate = moment.tz(date, 'Asia/Taipei');
    if (!targetDate.isValid()) {
      return res.status(400).send({ success: false, message: '無效的日期格式' });
    }

    const nextAvailableTime = await findNextAvailableTime(parsedServices, targetDate);
    if (nextAvailableTime) {
      res.status(200).send({
        success: true,
        nextAvailableTime: moment.tz(nextAvailableTime, 'Asia/Taipei').format('YYYY-MM-DD HH:mm:ss'),
      });
    } else {
      res.status(200).send({ success: false, message: '指定日期無可用時段' });
    }
  } catch (error) {
    console.error('❌ 查詢可用時段失敗:', error.message);
    res.status(500).send({ success: false, message: `查詢可用時段失敗，請稍後再試！ 錯誤詳情: ${error.message}` });
  }
});

// 寫入試算表函數（支援多人）
async function appendToSpreadsheet({ name, phone, guests, appointmentTime }) {
  try {
    const date = moment(appointmentTime).tz('Asia/Taipei').format('YYYY-MM-DD');
    const time = moment(appointmentTime).tz('Asia/Taipei').format('HH:mm');
    const sheetName = date;

    let sheetsResponse;
    try {
      sheetsResponse = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
      });
    } catch (error) {
      console.error('❌ 獲取試算表資訊失敗:', error.message);
      throw error;
    }

    const sheetExists = sheetsResponse.data.sheets.some(sheet => sheet.properties.title === sheetName);
    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: { rowCount: 100, columnCount: 10 },
                },
              },
            },
          ],
        },
      });
      console.log(`✅ 為日期 ${sheetName} 創建新工作表`);
    }

    const values = guests.map((guest, index) => {
      // 檢查 guest.service 是否存在且為字串
      if (!guest.service || typeof guest.service !== 'string') {
        console.error(`❌ 顧客 ${index + 1} 缺少有效的服務類型: ${JSON.stringify(guest)}`);
        throw new Error(`顧客 ${index + 1} 缺少有效的服務類型`);
      }
      return [
        date,
        `${name} (顧客 ${String.fromCharCode(65 + index)})`,
        phone,
        guest.service.split('_')[0],
        SERVICES[guest.service].duration,
        time,
        guest.master || '',
        '',
        '',
        '',
      ];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values },
    });

    console.log(`✅ 預約資料已写入試算表日期分頁 ${sheetName}: ${name}`);
  } catch (error) {
    console.error('❌ 寫入試算表失敗:', error.message);
    throw error;
  }
}

// 預約 API（支援多人）
server.post('/booking', async (req, res) => {
  if (!calendar || !sheets) {
    return res.status(500).send({ success: false, message: '伺服器配置錯誤，無法連接到 Google 服務' });
  }

  try {
    const { name, phone, guests, appointmentTime } = req.body;

    // 記錄請求資料以便排查
    console.log('收到預約請求:', JSON.stringify(req.body));

    if (!name || !phone || !guests || !appointmentTime) {
      return res.status(400).send({ success: false, message: '缺少必要的欄位' });
    }
    if (!moment(appointmentTime, moment.ISO_8601, true).isValid()) {
      return res.status(400).send({ success: false, message: '時間格式錯誤' });
    }
    if (!Array.isArray(guests) || guests.length === 0 || guests.length > 3) {
      return res.status(400).send({ success: false, message: '顧客人數無效，必須為 1 到 3 人' });
    }

    // 加強檢查：確保每個 guest 都有 service 屬性且有效
    for (const [index, guest] of guests.entries()) {
      if (!guest.service || typeof guest.service !== 'string') {
        console.error(`❌ 顧客 ${index + 1} 缺少服務類型: ${JSON.stringify(guest)}`);
        return res.status(400).send({ success: false, message: `顧客 ${index + 1} 缺少服務類型` });
      }
      if (!SERVICES[guest.service]) {
        console.error(`❌ 顧客 ${index + 1} 服務類型無效: ${guest.service}`);
        return res.status(400).send({ success: false, message: `無效的服務類型: ${guest.service}` });
      }
    }

    const startTime = moment.tz(appointmentTime, 'Asia/Taipei').toISOString();
    const maxDuration = Math.max(...guests.map(guest => SERVICES[guest.service].duration));
    const endTime = moment.tz(appointmentTime, 'Asia/Taipei').add(maxDuration, 'minutes').toISOString();

    const availability = await checkAvailability(guests, startTime, endTime);
    if (!availability.isAvailable) {
      return res.status(409).send({ 
        success: false, 
        message: availability.message,
      });
    }

    const events = [];
    const eventIds = [];
    const isSingleGuest = guests.length === 1;

    for (const [index, guest] of guests.entries()) {
      const serviceConfig = SERVICES[guest.service];
      const duration = serviceConfig.duration;
      const components = serviceConfig.components || [guest.service];
      let currentTime = moment.tz(appointmentTime, 'Asia/Taipei');

      for (const comp of components) {
        const compDuration = guest.service.includes('+') 
          ? (comp === '腳底按摩' ? 40 : duration - 40)
          : SERVICES[comp].duration;

        let colorId = undefined;
        if (guest.master && MASTER_COLORS[guest.master]) {
          colorId = MASTER_COLORS[guest.master];
        } else if (!guest.master) {
          colorId = MASTER_COLORS[''];
        }

        const guestLabel = isSingleGuest ? '' : ` (顧客 ${String.fromCharCode(65 + index)})`;
        const masterInfo = guest.master ? ` 指定: ${guest.master}` : ' 不指定';
        const event = {
          summary: `${comp} 預約：${name}${guestLabel}${masterInfo}`,
          description: `電話：${phone}${guest.master ? `\n師傅：${guest.master}` : ''}\n原始服務：${guest.service}\n總時長：${duration} 分鐘`,
          start: { dateTime: currentTime.toISOString(), timeZone: 'Asia/Taipei' },
          end: { dateTime: currentTime.clone().add(compDuration, 'minutes').toISOString(), timeZone: 'Asia/Taipei' },
          colorId: colorId,
        };
        const response = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          resource: event,
        });
        eventIds.push(response.data.id);
        events.push(event);
        currentTime.add(compDuration, 'minutes');
      }
    }

    await appendToSpreadsheet({
      name,
      phone,
      guests,
      appointmentTime: startTime,
    });

    res.status(200).send({ success: true, message: '預約成功！', eventIds });
  } catch (error) {
    console.error('❌ 創建事件失敗:', error.message);
    res.status(500).send({ success: false, message: `創建事件失敗，請稍後再試！ 錯誤詳情: ${error.message}` });
  }
});

// 啟動伺服器
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  keepAlive();
});
