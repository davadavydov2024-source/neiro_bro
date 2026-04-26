const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');

// --- КОНФИГУРАЦИЯ ---
const BOT_TOKEN = '8547861356:AAHV1gpk7UzpQKjHXS6csnXXqXRr9GZ-M2c';
const ADMIN_ID = 7040863301;
const GEMINI_KEY = 'AIzaSyDCXLwVN8E2yD6aF-N2wwA6PBpYHSYaDrI';
const DB_URL = "https://dogx-base-default-rtdb.firebaseio.com";

// Инициализация ИИ
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Быстрая и мощная модель

// Инициализация Firebase
// Важно: файл serviceAccountKey.json нужно получить в консоли Firebase (Project Settings -> Service Accounts)
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DB_URL
});
const db = admin.database();

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// --- ЭКСПРЕСС ДЛЯ РЕНДЕРА (АВТО-ПРОБУЖДЕНИЕ) ---
const app = express();
app.get('/', (req, res) => res.send('Бот активен!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP сервер запущен на порту ${PORT}`));

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

async function isSubscribed(ctx) {
  const settings = (await db.ref('settings').once('value')).val();
  if (!settings || !settings.channels || settings.channels.length === 0) return true;
  
  for (const channelId of settings.channels) {
    try {
      const member = await ctx.telegram.getChatMember(channelId, ctx.from.id);
      if (['left', 'kicked'].includes(member.status)) return false;
    } catch (e) { console.error(`Ошибка канала ${channelId}:`, e.message); }
  }
  return true;
}

function getSystemPrompt(level) {
  const prompts = {
    'fast': "Отвечай максимально коротко и по делу.",
    'think': "Рассуждай логически, давай развернутые и полезные ответы.",
    'pro': "Ты - эксперт высшего класса. Пиши идеальный код, сложные тексты и проводи глубокий анализ."
  };
  return prompts[level] || prompts['think'];
}

// --- ОБРАБОТЧИКИ ---

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const name = ctx.from.first_name || 'друг';
  
  await db.ref(`users/${userId}`).update({ name, username: ctx.from.username || 'none' });

  const settings = (await db.ref('settings').once('value')).val() || {};
  const welcomeText = (settings.welcome_text || "Привет, {name}👋, это нейро бро. Нажми «продолжить!» что бы я начал работу.")
    .replace('{name}', name);

  await ctx.reply(welcomeText, Markup.inlineKeyboard([[Markup.button.callback('Продолжить! 🚀', 'continue')]]));
});

bot.action('continue', async (ctx) => {
  if (!(await isSubscribed(ctx))) {
    const settings = (await db.ref('settings').once('value')).val();
    const buttons = settings.channels.map((ch, i) => [Markup.button.url(`Канал #${i+1}`, `https://t.me/${ch.replace('@','')}`)]);
    buttons.push([Markup.button.callback('Проверить подписку ✅', 'continue')]);
    return ctx.reply("🛑 Для доступа подпишись на каналы:", Markup.inlineKeyboard(buttons));
  }

  await ctx.editMessageText('Выбери уровень сложности моего ума:', Markup.inlineKeyboard([
    [Markup.button.callback('⚡️ Быстро', 'set_fast')],
    [Markup.button.callback('🧠 Думающая', 'set_think')],
    [Markup.button.callback('💎 Proшка', 'set_pro')]
  ]));
});

bot.action(/^set_(.+)$/, async (ctx) => {
  const level = ctx.match[1];
  await db.ref(`users/${ctx.from.id}`).update({ level });
  await ctx.answerCbQuery(`Установлен режим: ${level}`);
  await ctx.editMessageText('Напиши свой запрос. Я могу писать код, тексты или просто общаться!');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (text === '/admin' && userId === ADMIN_ID) {
    return ctx.reply('👑 Панель управления', Markup.inlineKeyboard([
      [Markup.button.callback('📊 Статистика', 'adm_stats')],
      [Markup.button.callback('📝 Изменить приветствие', 'adm_text')]
    ]));
  }

  const userSnap = await db.ref(`users/${userId}`).once('value');
  const userData = userSnap.val() || {};
  const today = new Date().toISOString().split('T')[0];

  if (userData.last_reset !== today) {
    await db.ref(`users/${userId}`).update({ daily_count: 0, last_reset: today });
    userData.daily_count = 0;
  }

  if (userData.daily_count >= 20 && userId !== ADMIN_ID) {
    return ctx.reply("🛑 Лимит запросов на сегодня исчерпан. Попробуй завтра!");
  }

  try {
    const wait = await ctx.reply("⏳ Думаю...");
    const result = await model.generateContent(`${getSystemPrompt(userData.level)}\nЗапрос: ${text}`);
    const response = await result.response;
    
    await db.ref(`users/${userId}`).update({ daily_count: (userData.daily_count || 0) + 1 });
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, response.text());
  } catch (e) {
    ctx.reply("❌ Произошла ошибка. Попробуй позже.");
  }
});

// Статистика для админа
bot.action('adm_stats', async (ctx) => {
  const users = (await db.ref('users').once('value')).val() || {};
  await ctx.reply(`👥 Всего пользователей: ${Object.keys(users).length}`);
});

bot.launch();
