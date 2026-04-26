const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const axios = require('axios');

// --- ДАННЫЕ ---
const BOT_TOKEN = '8547861356:AAHV1gpk7UzpQKjHXS6csnXXqXRr9GZ-M2c';
const ADMIN_ID = 7040863301;
const GEMINI_KEY = 'AIzaSyDCXLwVN8E2yD6aF-N2wwA6PBpYHSYaDrI';
const DB_URL = "https://dogx-base-default-rtdb.firebaseio.com";

// --- ИНИЦИАЛИЗАЦИЯ ---
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
if (firebaseConfig) {
    admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig),
        databaseURL: DB_URL
    });
}
const db = admin.database();
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// Авто-пробуждение
const app = express();
app.get('/', (req, res) => res.send('Neuro Bro is Online!'));
app.listen(process.env.PORT || 3000);

// --- СИСТЕМНЫЕ ПРОМПТЫ ---
const prompts = {
    'fast': "Отвечай максимально коротко и быстро.",
    'think': "Рассуждай логически, давай подробные ответы.",
    'pro': "Ты — эксперт. Пиши идеальный код, сложные тексты и делай глубокий анализ."
};

// --- ПРОВЕРКА ПОДПИСКИ ---
async function isSubscribed(ctx) {
    if (ctx.from.id === ADMIN_ID) return true;
    const snap = await db.ref('settings/channels').once('value');
    const channels = snap.val() || [];
    if (channels.length === 0) return true;

    for (const channel of channels) {
        try {
            const member = await ctx.telegram.getChatMember(channel, ctx.from.id);
            if (['left', 'kicked'].includes(member.status)) return false;
        } catch (e) { console.error("Ошибка проверки канала:", channel); }
    }
    return true;
}

// --- СТАРТ ---
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'Бро';
    
    await db.ref(`users/${userId}`).update({ name, username: ctx.from.username || '' });

    const settings = (await db.ref('settings').once('value')).val() || {};
    const text = (settings.welcome_text || "Привет, {name}👋, это нейро бро. нажми «продолжить!» что бы я начал работу.")
        .replace('{name}', name);
    const btnText = settings.welcome_btn || "Продолжить! 🚀";

    if (settings.welcome_photo) {
        await ctx.replyWithPhoto(settings.welcome_photo, {
            caption: text,
            ...Markup.inlineKeyboard([[Markup.button.callback(btnText, 'continue')]])
        });
    } else {
        await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback(btnText, 'continue')]]));
    }
});

// --- ЛОГИКА КНОПОК ---
bot.action('continue', async (ctx) => {
    if (!(await isSubscribed(ctx))) {
        const snap = await db.ref('settings/channels').once('value');
        const channels = snap.val() || [];
        const buttons = channels.map(ch => [Markup.button.url('Подписаться', `https://t.me/${ch.replace('@','')}`)]);
        buttons.push([Markup.button.callback('✅ Я подписался', 'continue')]);
        return ctx.reply("🛑 Для работы нужно подписаться на наши каналы:", Markup.inlineKeyboard(buttons));
    }

    await ctx.editMessageText('Выбери режим работы нейро бро:', Markup.inlineKeyboard([
        [Markup.button.callback('⚡️ Быстро', 'set_fast')],
        [Markup.button.callback('🧠 Думающая', 'set_think')],
        [Markup.button.callback('💎 Proшка', 'set_pro')]
    ]));
});

bot.action(/^set_(.+)$/, async (ctx) => {
    const level = ctx.match[1];
    await db.ref(`users/${ctx.from.id}`).update({ level });
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Режим "${level}" активирован! Напиши свой запрос. Помни про лимит 20 запросов.`);
});

// --- ОБРАБОТКА СООБЩЕНИЙ (AI + РИСОВАНИЕ) ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message.text;

    // Вход в админку
    if (msg === '/admin' && userId === ADMIN_ID) {
        return ctx.reply('👑 Панель управления', Markup.inlineKeyboard([
            [Markup.button.callback('📊 Статистика', 'adm_stats')],
            [Markup.button.callback('📝 Текст приветствия', 'adm_edit_text')],
            [Markup.button.callback('🖼 Фото приветствия', 'adm_edit_photo')],
            [Markup.button.callback('🔘 Текст кнопки', 'adm_edit_btn')],
            [Markup.button.callback('📢 Каналы (подписка)', 'adm_channels')]
        ]));
    }

    // Состояния ожидания админа
    const settingsSnap = await db.ref('settings').once('value');
    const settings = settingsSnap.val() || {};
    if (userId === ADMIN_ID && settings.waiting) {
        const type = settings.waiting;
        if (type === 'text') await db.ref('settings').update({ welcome_text: msg, waiting: null });
        if (type === 'btn') await db.ref('settings').update({ welcome_btn: msg, waiting: null });
        if (type === 'add_channel') {
            const channels = settings.channels || [];
            if (channels.length < 9) {
                channels.push(msg.startsWith('@') ? msg : `@${msg}`);
                await db.ref('settings').update({ channels, waiting: null });
            }
        }
        return ctx.reply("✅ Обновлено!");
    }

    // Проверка лимитов и режима
    const userSnap = await db.ref(`users/${userId}`).once('value');
    const userData = userSnap.val() || {};
    if (!userData.level) return ctx.reply("Нажми /start и выбери режим!");

    const today = new Date().toISOString().split('T')[0];
    if (userData.last_reset !== today) await db.ref(`users/${userId}`).update({ count: 0, last_reset: today });
    if ((userData.count || 0) >= 20 && userId !== ADMIN_ID) return ctx.reply("🛑 Лимит 20/20 исчерпан!");

    const wait = await ctx.reply("⏳ Нейро Бро в деле...");

    // РИСОВАНИЕ
    if (msg.toLowerCase().includes("нарисуй")) {
        const prompt = msg.replace(/нарисуй/gi, "").trim();
        const img = `https://pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${Date.now()}`;
        await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id);
        await ctx.replyWithPhoto(img, { caption: "🎨 Твой арт готов!" });
        return db.ref(`users/${userId}`).update({ count: (userData.count || 0) + 1 });
    }

    // GEMINI
    try {
        const result = await model.generateContent(`${prompts[userData.level]}\nЗапрос: ${msg}`);
        const responseText = result.response.text();
        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, responseText);
        await db.ref(`users/${userId}`).update({ count: (userData.count || 0) + 1 });
    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, "❌ Ошибка ИИ. Попробуй позже.");
    }
});

// Админ фото
bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const settings = (await db.ref('settings').once('value')).val() || {};
    if (settings.waiting === 'photo') {
        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await db.ref('settings').update({ welcome_photo: photoId, waiting: null });
        ctx.reply("✅ Фото обновлено!");
    }
});

// Кнопки админки (действия)
bot.action('adm_stats', async (ctx) => {
    const snap = await db.ref('users').once('value');
    ctx.reply(`👥 Всего юзеров: ${Object.keys(snap.val() || {}).length}`);
});
bot.action('adm_edit_text', (ctx) => {
    db.ref('settings').update({ waiting: 'text' });
    ctx.reply("Пришли новый текст (используй {name}):");
});
bot.action('adm_edit_photo', (ctx) => {
    db.ref('settings').update({ waiting: 'photo' });
    ctx.reply("Пришли новое фото:");
});
bot.action('adm_edit_btn', (ctx) => {
    db.ref('settings').update({ waiting: 'btn' });
    ctx.reply("Пришли текст для кнопки:");
});
bot.action('adm_channels', async (ctx) => {
    const snap = await db.ref('settings/channels').once('value');
    const channels = snap.val() || [];
    ctx.reply(`Каналы: ${channels.join(', ') || 'пусто'}\n\nЧтобы добавить, нажми кнопку ниже:`, 
    Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить', 'add_chan')],
        [Markup.button.callback('🗑 Очистить всё', 'clear_chan')]
    ]));
});
bot.action('add_chan', (ctx) => {
    db.ref('settings').update({ waiting: 'add_channel' });
    ctx.reply("Пришли юзернейм канала (например @my_channel):");
});
bot.action('clear_chan', async (ctx) => {
    await db.ref('settings/channels').remove();
    ctx.reply("✅ Список каналов очищен!");
});

bot.launch();
