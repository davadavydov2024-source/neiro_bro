const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const http = require('http');

// Инициализация бота
const token = '8547861356:AAHV1gpk7UzpQKjHXS6csnXXqXRr9GZ-M2c';
const bot = new Telegraf(token);
const ADMIN_ID = 7040863301;

// Firebase данные
const firebaseConfig = {
  databaseURL: "https://dogx-base-default-rtdb.firebaseio.com",
};

admin.initializeApp({
  credential: admin.credential.cert(require('./firebase-key.json')), // Нужно скачать ключ из Firebase Console
  databaseURL: firebaseConfig.databaseURL
});

const db = admin.database();

// --- АВТОПРОБУЖДЕНИЕ (Keep-alive) ---
http.createServer((req, res) => {
  res.write('Бот активен');
  res.end();
}).listen(process.env.PORT || 8080);

// --- ГЛАВНОЕ МЕНЮ ---
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const name = ctx.from.first_name || "друг";
  
  // Сохраняем пользователя в Firebase
  await db.ref(`users/${userId}`).update({
    id: userId,
    username: ctx.from.username || "none",
    last_seen: Date.now()
  });

  const welcomeText = `Привет, ${name}👋, это нейро бро. Нажми «продолжить!» чтобы я начал работу.`;
  await ctx.reply(welcomeText, Markup.inlineKeyboard([
    [Markup.button.callback('продолжить!', 'continue')]
  ]));
});

// --- ВЫБОР СЛОЖНОСТИ (УМА) ---
bot.action('continue', async (ctx) => {
  await ctx.editMessageText('Выбери уровень сложности моего ума:', Markup.inlineKeyboard([
    [Markup.button.callback('⚡️ Быстро', 'lvl_fast')],
    [Markup.button.callback('🧠 Думающая', 'lvl_think')],
    [Markup.button.callback('💎 PROшка', 'lvl_pro')]
  ]));
});

bot.action(/lvl_(.+)/, async (ctx) => {
  const level = ctx.match[1];
  await db.ref(`users/${ctx.from.id}`).update({ intelligence: level, requests: 0 });
  await ctx.reply(`Уровень "${level}" установлен. Напишите ваш запрос, а я постараюсь помочь вам.`);
});

// --- ОБРАБОТКА ЗАПРОСОВ (НЕЙРО БРО) ---
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;

  // Проверка на админа
  if (ctx.message.text === '/admin' && userId === ADMIN_ID) {
    const usersCount = (await db.ref('users').once('value')).numChildren();
    return ctx.reply(`👑 Админка\n\nВсего пользователей: ${usersCount}\n\nНастройки приветствия скоро появятся.`);
  }

  // Логика лимитов (пример: 20 запросов)
  const userSnapshot = await db.ref(`users/${userId}`).once('value');
  const userData = userSnapshot.val();
  
  if (userData.requests >= 20 && userId !== ADMIN_ID) {
    return ctx.reply('Твой лимит помощи на сегодня исчерпан! 🛑');
  }

  // Обновляем счетчик
  await db.ref(`users/${userId}`).update({ requests: (userData.requests || 0) + 1 });

  // Место для вызова AI API
  ctx.reply('🤖 Нейро Бро думает над твоим запросом...');
});

bot.launch();
console.log('Бот запущен идеально!');
