import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { bookingRouter } from './routes/booking';
import { sessionStore } from './session-store';
import {
  runDailyOrderReport,
  sendTelegram,
  answerCallbackQuery,
  editTelegramMessage,
  getSmartStoreToken,
  getNewOrderDetails,
  getDailySettlement,
} from './smartstore-scheduler';
import { sendEmail } from './email';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    'https://mawinpay-jarvis.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.FRONTEND_URL || '',
  ].filter(Boolean),
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/my-ip', async (req, res) => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json() as { ip: string };
    res.json({ ip: data.ip, message: 'IP' });
  } catch (e) {
    res.json({ ip: 'unknown', error: String(e) });
  }
});

app.get('/run-order-report', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET && secret !== 'jarvis2024') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await runDailyOrderReport();
    res.json({ success: true, message: 'done' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  try {
    if (update.callback_query) {
      const query = update.callback_query;
      const data = query.data as string;
      const messageId = query.message?.message_id;
      if (data.startsWith('confirm_dispatch_')) {
        const dateStr = data.replace('confirm_dispatch_', '');
        await answerCallbackQuery(query.id, 'processing...');
        await sendTelegram('preparing dispatch...');
        try { await processDispatch(dateStr, messageId); }
        catch (e) { await sendTelegram('error: ' + String(e)); }
      } else if (data.startsWith('send_dispatch_email_')) {
        const dateStr = data.replace('send_dispatch_email_', '');
        await answerCallbackQuery(query.id, 'sending...');
        try {
          const token = await getSmartStoreToken();
          if (!token) { await sendTelegram('auth failed'); return; }
          const orders = await getNewOrderDetails(token, dateStr, dateStr);
          let htmlBody = '<h2>' + dateStr + '</h2><table border="1">';
          for (const order of orders) {
            htmlBody += '<tr><td>' + (order.productName||'') + ' ' + (order.productOption||'') + '</td><td>' + (order.quantity||1) + '</td><td>' + (order.receiverName||'') + '</td></tr>';
          }
          htmlBody += '</table>';
          const { sendEmailNotification } = await import('./email');
          await sendEmailNotification({
            to: process.env.DISPATCH_EMAIL || 'jungsng805@naver.com',
            subject: '[Jarvis] ' + dateStr + ' dispatch (' + orders.length + ')',
            html: htmlBody,
          });
          await sendTelegram('\u2705 <b>\ubc1c\uc8fc\uc11c \uc774\uba54\uc77c \ubc1c\uc1a1 \uc644\ub8cc</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\ud83d\udcc5 \ub0a0\uc9dc: ' + dateStr + '\n\ud83d\udce6 \uc8fc\ubb38 \uc218: <b>' + orders.length + '\uac74</b>\n\ud83d\udce7 \ubc1c\uc1a1\uc758: ' + (process.env.DISPATCH_EMAIL || 'jungsng805@naver.com') + '\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        } catch (e) { await sendTelegram('email failed: ' + String(e)); }
      } else if (data === 'cancel_dispatch') {
        await answerCallbackQuery(query.id, 'cancelled');
        await sendTelegram('\u23f9 \ubc1c\uc8fc\uc11c \ubc1c\uc1a1\uc774 \ucde8\uc18c\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
      } else if (data === 'skip_dispatch') {
        await answerCallbackQuery(query.id, 'skipped');
      } else if (data.startsWith('confirm_settle_')) {
        const parts = data.replace('confirm_settle_', '').split('_');
        const dateStr = parts[0];
        const amount = parseInt(parts[1] || '0', 10);
        await answerCallbackQuery(query.id, 'confirmed!');
        await sendTelegram('\u2705 <b>\uc815\uc0b0 \ud655\uc778 \uc644\ub8cc</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\ud83d\udcc5 \ub0a0\uc9dc: ' + dateStr + '\n\ud83d\udcb0 \uc815\uc0b0 \uae08\uc561: <b>' + amount.toLocaleString('ko-KR') + '\uc6d0</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\uc815\uc0b0 \ub0b4\uc5ed\uc774 \ud655\uc778\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
      } else if (data.startsWith('recheck_settle_')) {
        const dateStr = data.replace('recheck_settle_', '');
        await answerCallbackQuery(query.id, 'rechecking...');
        const token = await getSmartStoreToken();
        if (token) {
          const settlement = await getDailySettlement(token, dateStr);
          if (settlement) {
            await sendTelegram('\ud83d\udcca <b>\uc815\uc0b0 \uc7ac\uc870\ud68c</b>\n' + dateStr + ': ' + settlement.settleAmount.toLocaleString('ko-KR') + '\uc6d0 (' + settlement.settleCount + '\uac74)',
              { inline_keyboard: [[{ text: '\u2705 \uc815\uc0b0 \ud655\uc778 \uc644\ub8cc', callback_data: 'confirm_settle_' + dateStr + '_' + settlement.settleAmount }]] });
          } else { await sendTelegram('settlement not found'); }
        }
      }
    }
    if (update.message) {
      const text = (update.message.text || '').trim();
      if (text === '/start') {
        await sendTelegram('\ud83d\udc4b <b>\uc790\ube44\uc2a4 \uc54c\ub9bc\ubd07</b>\n\ub9e4\uc77c \uc624\uc804 9\uc2dc \uc2a4\ub9c8\ud2b8\uc2a4\ud1a0\uc5b4 \uc8fc\ubb38 \ud604\ud669 \uc790\ub3d9 \ubcf4\uace0');
      } else if (text === '/report') {
        await sendTelegram('\ud83d\udd04 \uc870\ud68c \uc911...');
        await runDailyOrderReport();
      }
    }
  } catch (e) { console.error('[Webhook] error:', e); }
});

app.get('/setup-webhook', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET && secret !== 'jarvis2024') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : (process.env.SERVER_URL || '');
  if (!serverUrl) return res.status(400).json({ error: 'no SERVER_URL' });
  try {
    const webhookUrl = serverUrl + '/telegram-webhook';
    const result = await fetch('https://api.telegram.org/bot' + botToken + '/setWebhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await result.json();
    res.json({ success: true, webhookUrl, result: data });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

async function processDispatch(dateStr: string, originalMessageId?: number): Promise<void> {
  const token = await getSmartStoreToken();
  if (!token) { await sendTelegram('auth failed'); return; }
  const orders = await getNewOrderDetails(token, dateStr, dateStr);
  if (orders.length === 0) { await sendTelegram('no orders for ' + dateStr); return; }
  let summaryMsg = '\ud83d\udccb <b>\ubc1c\uc8fc\uc11c \ubc1c\uc1a1 \uc900\ube44</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\ud83d\udcc5 \ub0a0\uc9dc: ' + dateStr + '\n\ud83d\udce6 \uc8fc\ubb38: <b>' + orders.length + '\uac74</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\ud83d\udce7 jungsng805@naver.com\n\n\u26a0\ufe0f \ubc1c\uc8fc\uc11c \uc774\uba54\uc77c \ubc1c\uc1a1\ud558\uaca0\uc2b5\ub2c8\ub2e4. \ud655\uc778 \ud6c4 \uc544\ub798 \ubc84\ud2bc\uc744 \ub208\ub7ec\uc8fc\uc138\uc694.';
  await sendTelegram(summaryMsg, { inline_keyboard: [[{ text: '\u2705 \ubc1c\uc8fc\uc11c \uc774\uba54\uc77c \ubc1c\uc1a1', callback_data: 'send_dispatch_email_' + dateStr }, { text: '\u274c \ucde8\uc18c', callback_data: 'cancel_dispatch' }]] });
}

app.use('/api/booking', bookingRouter);

setInterval(() => { sessionStore.cleanup(); }, 60 * 60 * 1000);

function scheduleDaily9AM() {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(0, 0, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  const msUntilRun = nextRun.getTime() - now.getTime();
  console.log('next run:', nextRun.toISOString());
  setTimeout(async () => { await runDailyOrderReport(); scheduleDaily9AM(); }, msUntilRun);
}

scheduleDaily9AM();

app.listen(PORT, () => {
  console.log('Jarvis Booking Server running on port ' + PORT);
  autoSetupWebhook();
});

async function autoSetupWebhook() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || '';
  const serverUrl = process.env.SERVER_URL || '';
  const baseUrl = railwayDomain ? 'https://' + railwayDomain : serverUrl;
  if (!botToken || !baseUrl) { console.log('[Webhook] skip - no token or url'); return; }
  try {
    const webhookUrl = baseUrl + '/telegram-webhook';
    const result = await fetch('https://api.telegram.org/bot' + botToken + '/setWebhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await result.json() as any;
    if (data.ok) console.log('[Webhook] registered:', webhookUrl);
    else console.error('[Webhook] failed:', data.description);
  } catch (e) { console.error('[Webhook] error:', e); }
}
