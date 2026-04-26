const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');

// --- НАСТРОЙКИ ---
const BOT_TOKEN = '8547861356:AAHV1gpk7UzpQKjHXS6csnXXqXRr9GZ-M2c';
const ADMIN_ID = 7040863301;
const GEMINI_KEY = 'AIzaSyDCXLwVN8E2yD6aF-N2wwA6PBpYHSYaDrI';
const DB_URL = "https://dogx-base-default-rtdb.firebaseio.com";

// --- ИНИЦИАЛИЗАЦИЯ Firebase ---
let db;
try {
    const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    if (firebaseConfig) {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig),
            databaseURL: DB_URL
        });
        db = admin.database();
        console.log("✅ База данных подключена успешно!");
    }
} catch (e) {
    console.error("❌ Критическая ошибка Firebase:", e.message);
}

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const app = express();
app.get('/', (req, res) => res.send('Neuro Bro is Online 24/7!'));
app.listen(process.env.PORT || 3000);

// --- СИСТЕМНЫЕ НАСТРОЙКИ ---
const getPrompt = (lvl) => {
    const p = {
        'fast': "Отвечай максимально коротко и по делу.",
        'think': "Рассуждай подробно, давай логические объяснения.",
        'pro': "Ты — эксперт. Пиши чистый код, делай глубокий анализ и решай сложные задачи."
    };
    return p[lvl] || p.think;
};

// Проверка подписки (ОБЯЗАТЕЛЬНО)
async function checkSubscription(ctx) {
    if (ctx.from.id === ADMIN_ID) return true;
    const snap = await db.ref('settings/channels').once('value');
    const channels = snap.val() || [];
    if (channels.length === 0) return true;

    for (const ch of channels) {
        try {
            const member = await ctx.telegram.getChatMember(ch, ctx.from.id);
            if (['left', 'kicked'].includes(member.status)) return false;
        } catch (e) { continue; }
    }
    return true;
}

// --- ОСНОВНЫЕ КОМАНДЫ ---
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'Бро';
    if (db) await db.ref(`users/${userId}`).update({ name, username: ctx.from.username || 'none' });

    const settings = (await db.ref('settings').once('value')).val() || {};
    const welcomeText = (settings.welcome_text || "Привет, {name}👋! Я готов кодить и рисовать.").replace('{name}', name);
    const btnText = settings.welcome_btn || "Начать работу 🚀";

    const kb = Markup.inlineKeyboard([[Markup.button.callback(btnText, 'continue')]]);

    if (settings.welcome_photo) {
        return ctx.replyWithPhoto(settings.welcome_photo, { caption: welcomeText, ...kb }).catch(() => ctx.reply(welcomeText, kb));
    }
    ctx.reply(welcomeText, kb);
});

bot.action('continue', async (ctx) => {
    if (!(await checkSubscription(ctx))) {
        const snap = await db.ref('settings/channels').once('value');
        const channels = snap.val() || [];
        const buttons = channels.map(ch => [Markup.button.url('🔗 Подпишись', `https://t.me/${ch.replace('@','')}`)]);
        buttons.push([Markup.button.callback('✅ Проверить подписку', 'continue')]);
        return ctx.reply("🛑 Подпишись на наши каналы, чтобы продолжить:", Markup.inlineKeyboard(buttons));
    }
    await ctx.answerCbQuery();
    await ctx.editMessageText('Выбери режим работы Нейро Бро:', Markup.inlineKeyboard([
        [Markup.button.callback('⚡️ Быстрый', 'set_fast')],
        [Markup.button.callback('🧠 Подробный', 'set_think')],
        [Markup.button.callback('💎 Эксперт (Код)', 'set_pro')]
    ]));
});

bot.action(/^set_(.+)$/, async (ctx) => {
    const level = ctx.match[1];
    if (db) await db.ref(`users/${ctx.from.id}`).update({ level });
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Режим "${level}" включен! Пиши запрос или "нарисуй [что-то]".`);
});

// --- ГЛАВНАЯ ЛОГИКА ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message.text;

    // Панель админа
    if (msg === '/admin' && userId === ADMIN_ID) {
        return ctx.reply('👑 Админ-панель', Markup.inlineKeyboard([
            [Markup.button.callback('📊 Статистика', 'adm_stats')],
            [Markup.button.callback('📝 Сменить текст', 'adm_edit_text')],
            [Markup.button.callback('🖼 Сменить фото', 'adm_edit_photo')],
            [Markup.button.callback('📢 Каналы', 'adm_channels')]
        ]));
    }

    const settingsSnap = await db.ref('settings').once('value');
    const settings = settingsSnap.val() || {};

    // Ожидание ввода от админа
    if (userId === ADMIN_ID && settings.waiting) {
        if (settings.waiting === 'text') {
            await db.ref('settings').update({ welcome_text: msg, waiting: null });
            return ctx.reply("✅ Текст обновлен!");
        }
        if (settings.waiting === 'add_ch') {
            const channels = settings.channels || [];
            channels.push(msg.startsWith('@') ? msg : `@${msg}`);
            await db.ref('settings').update({ channels, waiting: null });
            return ctx.reply("✅ Канал добавлен!");
        }
    }

    // Проверка лимитов
    const userSnap = await db.ref(`users/${userId}`).once('value');
    const userData = userSnap.val() || {};
    const today = new Date().toISOString().split('T')[0];
    if (userData.last_reset !== today) await db.ref(`users/${userId}`).update({ count: 0, last_reset: today });
    if ((userData.count || 0) >= 20 && userId !== ADMIN_ID) return ctx.reply("🛑 Лимит 20/20 исчерпан. Жди завтра!");

    const wait = await ctx.reply("⏳ Нейро Бро думает...");

    // РИСОВАНИЕ
    if (msg.toLowerCase().includes("нарисуй")) {
        try {
            const prompt = msg.replace(/нарисуй/gi, "").trim();
            const url = `https://pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${Date.now()}`;
            await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id);
            await ctx.replyWithPhoto(url, { caption: `🎨 Готово по запросу: ${prompt}` });
            return db.ref(`users/${userId}`).child('count').set((userData.count || 0) + 1);
        } catch (e) { return ctx.reply("❌ Ошибка рисования."); }
    }

    // AI ОТВЕТ
    try {
        const result = await model.generateContent(`${getPrompt(userData.level)}\n\nЗапрос: ${msg}`);
        const responseText = result.response.text();
        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, responseText);
        await db.ref(`users/${userId}`).child('count').set((userData.count || 0) + 1);
    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, "❌ Ошибка ИИ. Проверь лимиты ключа Gemini.");
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

// Действия админа
bot.action('adm_stats', async (ctx) => {
    const snap = await db.ref('users').once('value');
    ctx.reply(`👥 Всего юзеров: ${Object.keys(snap.val() || {}).length}`);
});
bot.action('adm_edit_text', (ctx) => {
    db.ref('settings').update({ waiting: 'text' });
    ctx.reply("Пришли новый текст приветствия:");
});
bot.action('adm_edit_photo', (ctx) => {
    db.ref('settings').update({ waiting: 'photo' });
    ctx.reply("Пришли новое фото:");
});
bot.action('adm_channels', (ctx) => {
    db.ref('settings').update({ waiting: 'add_ch' });
    ctx.reply("Пришли юзернейм канала для подписки (например @mychannel):");
});

bot.catch((err) => console.error("🛑 Ошибка в Telegraf:", err));
bot.launch().then(() => console.log("🚀 Бот в сети!"));
