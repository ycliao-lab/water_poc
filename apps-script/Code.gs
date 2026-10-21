/**
 * 花蓮水 線上訂購後端（Google Apps Script）
 *
 * 用法：在 Google 試算表中開啟「擴充功能 → Apps Script」，貼上本檔內容。
 * 1. 執行一次 setup()：建立「訂單」工作表、欄位、狀態下拉選單，並寫入預設設定。
 * 2. 在「專案設定 → 指令碼屬性」修改通知設定（見 DEFAULT_PROPS）。
 * 3. 部署 → 新增部署作業 → 網頁應用程式：
 *      執行身分：我　　存取權：所有人
 *    取得 .../exec 網址，填入網站 index.html 的 CONFIG.GAS_URL。
 * 4. 可執行 testOrder() 測試寫入與通知。
 */

/* ---------- 品項與價格：需與網站 PRODUCTS 一致；以伺服器端價格為準 ---------- */
const PRODUCTS = {
  'jug-square':  { name: '方桶裝花蓮水 5加侖',   unit: '桶', price: 80,   deposit: 350 },
  'jug-round':   { name: '圓桶裝花蓮水 5加侖',   unit: '桶', price: 80,   deposit: 200 },
  'bottle-1500': { name: '花蓮水 1500cc',        unit: '箱', price: 230,  ship: true },
  'bottle-600':  { name: '花蓮水 600cc',         unit: '箱', price: 230,  ship: true },
  'lotus-1500':  { name: '蓮花水 1500cc 弱鹼性', unit: '箱', price: 360 },
  'box-20l':     { name: '拋棄式紙箱水 20公升',  unit: '箱', price: 150 },
  'cup-box':     { name: '隨手杯 箱裝',          unit: '箱', price: 150 },
  'disp-stand':  { name: '冰冷熱飲水機 直立式',  unit: '台', price: 5000 },
  'disp-desk':   { name: '冷熱飲水機 桌上型',    unit: '台', price: 2500 }
};

const METHODS = {
  hualien: '花蓮在地配送',
  taitung: '台東在地配送',
  nationwide: '全省宅配',
  pickup: '門市自取'
};

const SHEET_NAME = '訂單';
const STATUSES = ['新訂單', '已確認', '配送中', '已完成', '已取消'];
const TZ = 'Asia/Taipei';

/* 指令碼屬性預設值（setup 時寫入，之後到「專案設定」修改） */
const DEFAULT_PROPS = {
  NOTIFY_EMAILS: '',          // 新訂單通知信收件人，多位以逗號分隔；留空則寄給部署者本人
  SEND_CUSTOMER_EMAIL: 'true',// 客人有填 Email 時寄確認信
  LINE_CHANNEL_TOKEN: '',     // LINE Messaging API 的 Channel access token（長效）
  LINE_TO: '',                // 推播對象：使用者 ID（U 開頭）或群組 ID（C 開頭），多個以逗號分隔
  STORE_PHONE: '03-856-2118'
};

const HEADERS = [
  '訂單編號', '下單時間', '狀態', '姓名', '電話', '配送方式', '地址',
  '希望日期', '時段', '付款方式', '品項明細', '商品金額', '押桶費', '合計',
  '空桶交換', 'LINE ID', 'Email', '備註', '內部備註', '來源'
].concat(Object.keys(PRODUCTS).map(id => PRODUCTS[id].name));

/* ============================== 入口 ============================== */

function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // 防機器人：隱藏欄位有值即丟棄，回傳假成功
    // LINE webhook：用來取得推播對象 ID（見 handleLineWebhook_）
    if (Array.isArray(data.events)) return handleLineWebhook_(data.events);

    if (data.website) return json_({ ok: true, orderId: 'HW-IGNORED', total: 0 });

    const order = buildOrder_(data);
    rateLimit_(order.phone);

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      order.id = nextOrderId_();
      appendOrder_(order);
    } finally {
      lock.releaseLock();
    }

    notify_(order);
    return json_({ ok: true, orderId: order.id, total: order.total });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: err.message || String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'hualien-water-order', time: new Date().toISOString() });
}

/* ============================== 訂單處理 ============================== */

function buildOrder_(d) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
  const phone = str(d.phone, 20).replace(/[\s\-()]/g, '');

  if (!str(d.name)) throw new Error('請填寫姓名');
  if (!/^0\d{8,9}$/.test(phone)) throw new Error('電話格式不正確');
  if (!METHODS[d.method]) throw new Error('請選擇配送方式');
  if (d.method !== 'pickup' && !str(d.address)) throw new Error('請填寫配送地址');

  const hasEmpty = d.hasEmpty === true || d.hasEmpty === 'true';
  const lines = [];
  (Array.isArray(d.items) ? d.items : []).forEach(it => {
    const p = PRODUCTS[it && it.id];
    const q = Math.floor(Number(it && it.qty));
    if (!p || !(q > 0) || q > 99) return;
    if (d.method === 'nationwide' && !p.ship) throw new Error(p.name + ' 不提供全省宅配');
    lines.push({
      id: it.id, name: p.name, unit: p.unit, qty: q,
      subtotal: p.price * q,
      deposit: p.deposit && !hasEmpty ? p.deposit * q : 0
    });
  });
  if (!lines.length) throw new Error('訂單沒有品項');

  const goods = lines.reduce((s, l) => s + l.subtotal, 0);
  const deposit = lines.reduce((s, l) => s + l.deposit, 0);

  return {
    time: new Date(),
    name: str(d.name, 50),
    phone: phone,
    method: d.method,
    methodLabel: METHODS[d.method],
    address: str(d.address),
    date: str(d.date, 10),
    slot: str(d.slot, 10),
    payment: str(d.payment, 20),
    lineId: str(d.lineId, 50),
    email: str(d.email, 100),
    note: str(d.note, 500),
    hasEmpty: hasEmpty,
    source: str(d.source, 200),
    lines: lines,
    goods: goods,
    deposit: deposit,
    total: goods + deposit
  };
}

function itemsText_(o) {
  return o.lines.map(l => `${l.name} × ${l.qty}${l.unit}`).join('\n');
}

function appendOrder_(o) {
  const sh = getSheet_();
  const qtyCols = Object.keys(PRODUCTS).map(id => {
    const l = o.lines.find(x => x.id === id);
    return l ? l.qty : '';
  });
  const row = [
    o.id, o.time, '新訂單', o.name, "'" + o.phone, o.methodLabel, o.address,
    o.date, o.slot, o.payment, itemsText_(o), o.goods, o.deposit, o.total,
    o.hasEmpty ? '是' : '', o.lineId, o.email, o.note, '', o.source
  ].concat(qtyCols);
  sh.appendRow(row);
}

function nextOrderId_() {
  const props = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), TZ, 'yyMMdd');
  const key = 'SEQ_' + day;
  const n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return 'HW' + day + '-' + ('00' + n).slice(-3);
}

function rateLimit_(phone) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + phone;
  if (cache.get(key)) throw new Error('剛剛已收到這支電話的訂單，請稍候一分鐘再送出，或直接來電');
  cache.put(key, '1', 60);
}

/* ============================== 通知 ============================== */

function notify_(o) {
  const p = PropertiesService.getScriptProperties().getProperties();
  const text = orderText_(o);

  // 1. Email 通知店家
  try {
    const to = p.NOTIFY_EMAILS || Session.getEffectiveUser().getEmail();
    MailApp.sendEmail({
      to: to,
      subject: `【花蓮水新訂單】${o.id} ${o.name} ${o.methodLabel} $${o.total}`,
      body: text + '\n\n訂單試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
    });
  } catch (err) { console.error('Email 通知失敗', err); }

  // 2. LINE 推播（有設定才送）
  if (p.LINE_CHANNEL_TOKEN && p.LINE_TO) {
    p.LINE_TO.split(',').map(s => s.trim()).filter(Boolean).forEach(to => {
      try {
        const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
          method: 'post',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + p.LINE_CHANNEL_TOKEN },
          payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: '花蓮水新訂單\n' + text }] }),
          muteHttpExceptions: true
        });
        if (res.getResponseCode() !== 200) console.error('LINE 推播失敗', res.getContentText());
      } catch (err) { console.error('LINE 推播失敗', err); }
    });
  }

  // 3. 客人確認信
  if (o.email && p.SEND_CUSTOMER_EMAIL !== 'false') {
    try {
      MailApp.sendEmail({
        to: o.email,
        subject: `花蓮水訂單確認 ${o.id}`,
        body: `${o.name} 您好：\n\n已收到您的訂單，我們會在營業時間內來電確認配送時間。\n\n` +
              text + `\n\n如需更改訂單，請來電 ${p.STORE_PHONE || DEFAULT_PROPS.STORE_PHONE}。\n花蓮水 言晟股份有限公司`
      });
    } catch (err) { console.error('客人確認信失敗', err); }
  }
}

function orderText_(o) {
  const lines = [
    `訂單編號：${o.id}`,
    `時間：${Utilities.formatDate(o.time, TZ, 'yyyy/MM/dd HH:mm')}`,
    `姓名：${o.name}`,
    `電話：${o.phone}`,
    `配送：${o.methodLabel}`,
    o.address ? `地址：${o.address}` : null,
    o.date || o.slot ? `希望時間：${o.date || '不指定日期'} ${o.slot || ''}` : null,
    `付款：${o.payment}`,
    '',
    itemsText_(o),
    '',
    `商品金額：$${o.goods}`,
    o.deposit ? `押桶費：$${o.deposit}` : (o.hasEmpty ? '押桶費：空桶交換' : null),
    `合計：$${o.total}`,
    o.lineId ? `LINE ID：${o.lineId}` : null,
    o.note ? `備註：${o.note}` : null
  ];
  return lines.filter(l => l !== null).join('\n');
}

/* ============================== 工作表 ============================== */

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || setupSheet_(ss);
}

function setupSheet_(ss) {
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME, 0);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#0E3B5C').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);

  const statusCol = HEADERS.indexOf('狀態') + 1;
  const statusRange = sh.getRange(2, statusCol, sh.getMaxRows() - 1, 1);
  statusRange.setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build()
  );

  const colors = { '新訂單': '#FFF4DE', '已確認': '#E6F1F8', '配送中': '#E3EEFF', '已完成': '#E5F4EA', '已取消': '#EEEEEE' };
  const rules = Object.keys(colors).map(s =>
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=$C2="${s}"`)
      .setBackground(colors[s])
      .setRanges([sh.getRange(2, 1, sh.getMaxRows() - 1, HEADERS.length)])
      .build()
  );
  sh.setConditionalFormatRules(rules);

  sh.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
  ['商品金額', '押桶費', '合計'].forEach(h => {
    const c = HEADERS.indexOf(h) + 1;
    sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('$#,##0');
  });
  sh.getRange('K:K').setWrap(true);
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(7, 260);
  sh.setColumnWidth(11, 220);
  return sh;
}

/* 第一次使用：手動執行一次 */
function setup() {
  setupSheet_(SpreadsheetApp.getActiveSpreadsheet());
  const props = PropertiesService.getScriptProperties();
  const cur = props.getProperties();
  Object.keys(DEFAULT_PROPS).forEach(k => { if (!(k in cur)) props.setProperty(k, DEFAULT_PROPS[k]); });
  console.log('設定完成。請到「專案設定 → 指令碼屬性」填寫通知收件人與 LINE 設定，然後部署為網頁應用程式。');
}

/* 測試：模擬一筆訂單（會寫入試算表並發送通知） */
function testOrder() {
  const res = doPost({ postData: { contents: JSON.stringify({
    name: '測試客人', phone: '0912345678', method: 'hualien',
    address: '花蓮縣吉安鄉建國路一段117巷10號', date: '', slot: '上午', payment: '貨到付款',
    email: '', note: '這是測試訂單', hasEmpty: false,
    items: [{ id: 'jug-square', qty: 2 }, { id: 'bottle-1500', qty: 1 }],
    source: 'testOrder'
  }) } });
  console.log(res.getContent());
}

/* ============================== LINE 綁定 ============================== */

/**
 * 在 LINE Developers 把 Webhook URL 設為本程式的 /exec 網址並開啟 Use webhook 後：
 * - 店家在官方帳號聊天室（或加入官方帳號的群組）輸入「綁定」，
 *   機器人會回覆該聊天室的 ID，並記錄在「LINE綁定」工作表。
 * - 把回覆的 ID 填入指令碼屬性 LINE_TO 即可收到新訂單推播。
 * 回覆使用 Reply API，不計入每月推播則數。
 */
function handleLineWebhook_(events) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN');
  events.forEach(ev => {
    if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
    if (ev.message.text.trim() !== '綁定') return;
    const src = ev.source || {};
    const id = src.groupId || src.roomId || src.userId;
    const kind = src.groupId ? '群組' : src.roomId ? '聊天室' : '個人';

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('LINE綁定') || ss.insertSheet('LINE綁定');
    if (sh.getLastRow() === 0) sh.appendRow(['時間', '類型', 'ID']);
    sh.appendRow([new Date(), kind, id]);

    if (token && ev.replyToken) {
      UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text',
          text: `此${kind}的 ID：\n${id}\n\n請將這串 ID 填入 Apps Script 指令碼屬性 LINE_TO，多個以逗號分隔。` }] }),
        muteHttpExceptions: true
      });
    }
  });
  return json_({ ok: true });
}

/* 測試 LINE 推播：設定好 LINE_CHANNEL_TOKEN 與 LINE_TO 後手動執行 */
function testLine() {
  const p = PropertiesService.getScriptProperties().getProperties();
  if (!p.LINE_CHANNEL_TOKEN || !p.LINE_TO) throw new Error('請先設定 LINE_CHANNEL_TOKEN 與 LINE_TO');
  p.LINE_TO.split(',').map(s => s.trim()).filter(Boolean).forEach(to => {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + p.LINE_CHANNEL_TOKEN },
      payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: '花蓮水訂單通知測試：LINE 推播設定成功' }] }),
      muteHttpExceptions: true
    });
    console.log(to, res.getResponseCode(), res.getContentText());
  });
}

/* ============================== 工具 ============================== */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
