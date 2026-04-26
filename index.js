const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');

// --- КОНФИГУРАЦИЯ ---
const BOT_TOKEN = '8547861356:AAHV1gpk7UzpQKjHXS6csnXXqXRr9GZ-M2c';
const ADMIN_ID = 7040863301;
const GEMINI_KEY = 'AIzaSyDCXLwVN8E2yD6aF-N2wwA6PBpYHSYaDrI';
const DB_URL = "https://dogx-base-default-rtdb.firebaseio.com";

// Инициализация ИИ и Firebase
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
if (firebaseConfig) {
    admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig),
        databaseURL: DB_URL
    });
}
const db = admin.database();
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// --- АВТО-ПРОБУЖДЕНИЕ ---
const app = express();
app.get('/', (req, res) => res.send('Бот активен!'));
app.listen(process.env.PORT || 3000);

// --- ЛОГИКА ПРОВЕРКИ ПОДПИСКИ ---
async function checkSub(ctx) {
    const settings = (await db.ref('settings').once('value')).val() || {};
    if (!settings.channels) return true;
    for (const ch of settings.channels) {
        try {
            const member = await ctx.telegram.getChatMember(ch, ctx.from.id);
            if (['left', 'kicked'].includes(member.status)) return false;
        } catch (e) { console.error("Ошибка канала:", ch); }
    }
    return true;
}

// --- СТАРТ ---
bot.start(async (ctx) => {
    const name = ctx.from.first_name || 'друг';
    await db.ref(`users/${ctx.from.id}`).update({ name, username: ctx.from.username || 'none' });
    
    const settings = (await db.ref('settings').once('value')).val() || {};
    const text = (settings.welcome_text || "Привет, {name}👋, это нейро бро. Нажми «продолжить!» что бы я начал работу.")
        .replace('{name}', name);
    
    if (settings.welcome_photo) {
        await ctx.replyWithPhoto(settings.welcome_photo, { caption: text, ...Markup.inlineKeyboard([[Markup.button.callback('Продолжить! 🚀', 'continue')]]) });
    } else {
        await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('Продолжить! 🚀', 'continue')]]));
    }
});

// --- ВЫБОР УМА ---
bot.action('continue', async (ctx) => {
    if (!(await checkSub(ctx))) return ctx.reply("🛑 Подпишись на каналы что бы пользоваться ботом!");
    await ctx.editMessageText('Выбери уровень сложности моего ума:', Markup.inlineKeyboard([
        [Markup.button.callback('⚡️ Быстро', 'set_fast')],
        [Markup.button.callback('🧠 Думающая', 'set_think')],
        [Markup.button.callback('💎 Proшка', 'set_pro')]
    ]));
});

bot.action(/^set_(.+)$/, async (ctx) => {
    const level = ctx.match[1];
    await db.ref(`users/${ctx.from.id}`).update({ level });
    await ctx.editMessageText(`Уровень "${level}" установлен. Напиши запрос (могу рисовать, если напишешь "нарисуй ...")!`);
});

// --- ОБРАБОТКА СООБЩЕНИЙ (AI + КАРТИНКИ + АДМИН) ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message.text;

    // Админка
    if (msg === '/admin' && userId === ADMIN_ID) {
        return ctx.reply('👑 Админка', Markup.inlineKeyboard([
            [Markup.button.callback('📊 Статистика', 'adm_stats')],
            [Markup.button.callback('📝 Изменить текст', 'adm_edit_text')],
            [Markup.button.callback('🖼 Изменить фото', 'adm_edit_photo')]
        ]));
    }

    // Состояние ожидания для админа
    const settingsSnap = await db.ref('settings').once('value');
    const settings = settingsSnap.val() || {};

    if (userId === ADMIN_ID && settings.waiting) {
        if (settings.waiting === 'text') {
            await db.ref('settings').update({ welcome_text: msg, waiting: null });
            return ctx.reply("✅ Текст обновлен!");
        }
    }

    // Лимиты
    const userSnap = await db.ref(`users/${userId}`).once('value');
    const userData = userSnap.val() || {};
    const today = new Date().toISOString().split('T')[0];
    if (userData.last_date !== today) await db.ref(`users/${userId}`).update({ count: 0, last_date: today });
    if ((userData.count || 0) >= 20 && userId !== ADMIN_ID) return ctx.reply("🛑 Лимит 20/20 исчерпан.");

    const wait = await ctx.reply("⏳ Думаю...");

    // ГЕНЕРАЦИЯ КАРТИНОК
    if (msg.toLowerCase().includes("нарисуй") || msg.toLowerCase().includes("draw")) {
        try {
            const prompt = encodeURIComponent(msg.replace(/нарисуй|draw/gi, "").trim());
            const imageUrl = `https://pollinations.ai/p/${prompt}?width=1024&height=1024&seed=${Math.floor(Math.random() * 100000)}`;
            await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id);
            await ctx.replyWithPhoto(imageUrl, { caption: "🎨 Твой арт готов!" });
            return await db.ref(`users/${userId}`).update({ count: (userData.count || 0) + 1 });
        } catch (e) { return ctx.reply("Ошибочка при рисовании."); }
    }

    // ТЕКСТОВЫЙ ОТВЕТ (GEMINI)
    try {
        const prompt = `${userData.level === 'pro' ? 'Ты эксперт.' : 'Будь краток.'} Запрос: ${msg}`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, response.text());
        await db.ref(`users/${userId}`).update({ count: (userData.count || 0) + 1 });
    } catch (e) {
        ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, "❌ Ошибка ИИ. Проверь ключ Gemini.");
    }
});

// Обработка фото для админки
bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const settings = (await db.ref('settings').once('value')).val() || {};
    if (settings.waiting === 'photo') {
        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await db.ref('settings').update({ welcome_photo: photoId, waiting: null });
        ctx.reply("✅ Фото приветствия обновлено!");
    }
});

// Кнопки админа
bot.action('adm_stats', async (ctx) => {
    const snap = await db.ref('users').once('value');
    ctx.reply(`📊 Пользователей: ${Object.keys(snap.val() || {}).length}`);
});
bot.action('adm_edit_text', (ctx) => {
    db.ref('settings').update({ waiting: 'text' });
    ctx.reply("Пришли новый текст (используй {name}):");
});
bot.action('adm_edit_photo', (ctx) => {
    db.ref('settings').update({ waiting: 'photo' });
    ctx.reply("Пришли новое фото:");
});

bot.launch();
