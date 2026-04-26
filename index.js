const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
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
    } else {
        console.warn("⚠️ FIREBASE_CONFIG не найден! Бот работает без БД.");
    }
} catch (e) {
    console.error("❌ Ошибка Firebase:", e.message);
}

// --- ИНИЦИАЛИЗАЦИЯ GEMINI С НАСТРОЙКАМИ БЕЗОПАСНОСТИ ---
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    safetySettings 
});

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

// Проверка подписки
async function checkSubscription(ctx) {
    if (ctx.from.id === ADMIN_ID) return true;
    if (!db) return true; 
    
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
    
    let settings = {};
    if (db) {
        await db.ref(`users/${userId}`).update({ name, username: ctx.from.username || 'none' });
        settings = (await db.ref('settings').once('value')).val() || {};
    }

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
        let channels = [];
        if (db) {
            const snap = await db.ref('settings/channels').once('value');
            channels = snap.val() || [];
        }
        const buttons = channels.map(ch => [Markup.button.url('🔗 Подпишись', `https://t.me/${ch.replace('@','')}`)]);
        buttons.push([Markup.button.callback('✅ Проверить подписку', 'continue')]);
        
        await ctx.deleteMessage().catch(() => {});
        return ctx.reply("🛑 Подпишись на наши каналы, чтобы продолжить:", Markup.inlineKeyboard(buttons));
    }
    
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    
    await ctx.reply('Выбери режим работы Нейро Бро:', Markup.inlineKeyboard([
        [Markup.button.callback('⚡️ Быстрый', 'set_fast')],
        [Markup.button.callback('🧠 Подробный', 'set_think')],
        [Markup.button.callback('💎 Эксперт (Код)', 'set_pro')]
    ]));
});

bot.action(/^set_(.+)$/, async (ctx) => {
    const level = ctx.match[1];
    if (db) await db.ref(`users/${ctx.from.id}`).update({ level });
    
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(`Режим "${level}" включен! Пиши запрос или "нарисуй [что-то]".`);
});

// --- ГЛАВНАЯ ЛОГИКА ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message.text;

    if (msg === '/admin' && userId === ADMIN_ID) {
        return ctx.reply('👑 Админ-панель', Markup.inlineKeyboard([
            [Markup.button.callback('📊 Статистика', 'adm_stats')],
            [Markup.button.callback('📝 Сменить текст', 'adm_edit_text')],
            [Markup.button.callback('🖼 Сменить фото', 'adm_edit_photo')],
            [Markup.button.callback('📢 Каналы', 'adm_channels')]
        ]));
    }

    if (userId === ADMIN_ID && db) {
        const settingsSnap = await db.ref('settings').once('value');
        const settings = settingsSnap.val() || {};
        if (settings.waiting) {
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
    }

    let userData = {};
    if (db) {
        const userSnap = await db.ref(`users/${userId}`).once('value');
        userData = userSnap.val() || {};
        const today = new Date().toISOString().split('T')[0];
        if (userData.last_reset !== today) await db.ref(`users/${userId}`).update({ count: 0, last_reset: today });
        if ((userData.count || 0) >= 20 && userId !== ADMIN_ID) return ctx.reply("🛑 Лимит 20/20 исчерпан. Жди завтра!");
    }

    const wait = await ctx.reply("⏳ Нейро Бро думает...");

    if (msg.toLowerCase().includes("нарисуй")) {
        try {
            const prompt = msg.replace(/нарисуй/gi, "").trim();
            const url = `https://pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${Date.now()}`;
            await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id);
            await ctx.replyWithPhoto(url, { caption: `🎨 Готово по запросу: ${prompt}` });
            if (db) db.ref(`users/${userId}`).child('count').set((userData.count || 0) + 1);
            return;
        } catch (e) { return ctx.reply("❌ Ошибка рисования."); }
    }

    // --- ОБНОВЛЕННЫЙ БЛОК Gemini С ДИАГНОСТИКОЙ ---
    try {
        const userLevel = userData.level || 'think';
        const promptText = `${getPrompt(userLevel)}\n\nЗапрос: ${msg}`;
        
        const result = await model.generateContent(promptText);
        const response = await result.response;
        const responseText = response.text();

        if (!responseText) throw new Error("Модель вернула пустой ответ.");

        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, responseText);
        if (db) db.ref(`users/${userId}`).child('count').set((userData.count || 0) + 1);
    } catch (e) {
        console.error("Gemini Error:", e);
        // Теперь здесь выводится реальное сообщение об ошибке
        const errorMessage = e.message || "Неизвестная ошибка API";
        await ctx.telegram.editMessageText(
            ctx.chat.id, 
            wait.message_id, 
            null, 
            `❌ Ошибка ИИ: ${errorMessage}\n\nПожалуйста, проверьте логи или регион сервера.`
        );
    }
});

bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID || !db) return;
    const settings = (await db.ref('settings').once('value')).val() || {};
    if (settings.waiting === 'photo') {
        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await db.ref('settings').update({ welcome_photo: photoId, waiting: null });
        ctx.reply("✅ Фото обновлено!");
    }
});

bot.action('adm_stats', async (ctx) => {
    if (!db) return ctx.answerCbQuery("БД не подключена");
    const snap = await db.ref('users').once('value');
    ctx.reply(`👥 Всего юзеров: ${Object.keys(snap.val() || {}).length}`);
    ctx.answerCbQuery();
});
bot.action('adm_edit_text', (ctx) => {
    if (db) db.ref('settings').update({ waiting: 'text' });
    ctx.reply("Пришли новый текст приветствия:");
    ctx.answerCbQuery();
});
bot.action('adm_edit_photo', (ctx) => {
    if (db) db.ref('settings').update({ waiting: 'photo' });
    ctx.reply("Пришли новое фото:");
    ctx.answerCbQuery();
});
bot.action('adm_channels', (ctx) => {
    if (db) db.ref('settings').update({ waiting: 'add_ch' });
    ctx.reply("Пришли юзернейм канала для подписки (например @mychannel):");
    ctx.answerCbQuery();
});

bot.catch((err, ctx) => {
    console.error(`🛑 Ошибка в Telegraf:`, err);
});

bot.launch().then(() => console.log("🚀 Бот в сети!"));
