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
} else {
    console.error("❌ ОШИБКА: Переменная FIREBASE_CONFIG не найдена!");
}
const db = admin.database();
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// --- АВТО-ПРОБУЖДЕНИЕ ---
const app = express();
app.get('/', (req, res) => res.send('Бот активен!'));
app.listen(process.env.PORT || 3000);

// --- ЛОГИКА ПРОВЕРКИ ПОДПИСКИ (ЗАГЛУШКА) ---
async function checkSub(ctx) {
    const settings = (await db.ref('settings').once('value')).val() || {};
    if (!settings.channels) return true; // Если каналы не заданы - пускаем
    // Здесь должна быть реальная проверка getChatMember (я её упростил для теста)
    return true;
}

// Промпты для уровней сложности
const systemPrompts = {
    'fast': "Ты - Нейро Бро. Отвечай максимально кратко, чётко и быстро, как робот.",
    'think': "Ты - Нейро Бро. Рассуждай логически, давай развернутые и полезные ответы.",
    'pro': "Ты - Нейро Бро. Ты эксперт высшего класса. Пиши идеальный код, глубокие тексты и проводи глубокий анализ."
};

// --- СТАРТ ---
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'друг';
    await db.ref(`users/${userId}`).update({ name, username: ctx.from.username || 'none' });
    
    const settings = (await db.ref('settings').once('value')).val() || {};
    const text = (settings.welcome_text || "Привет, {name}👋, это нейро бро. Нажми «продолжить!» что бы я начал работу.")
        .replace('{name}', name);
    
    if (settings.welcome_photo) {
        try {
            await ctx.replyWithPhoto(settings.welcome_photo, { caption: text, ...Markup.inlineKeyboard([[Markup.button.callback('Продолжить! 🚀', 'continue')]]) });
        } catch (e) {
            await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('Продолжить! 🚀', 'continue')]]));
        }
    } else {
        await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('Продолжить! 🚀', 'continue')]]));
    }
});

// --- ВЫБОР УМА ---
bot.action('continue', async (ctx) => {
    if (!(await checkSub(ctx))) return ctx.answerCbQuery("🛑 Сначала подпишись на каналы!");
    
    await ctx.answerCbQuery();
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
    await ctx.editMessageText(`Уровень "${level}" установлен. Напиши запрос. Могу рисовать, если напишешь "нарисуй собаку".`);
});

// --- ОБРАБОТКА СООБЩЕНИЙ (AI + КАРТИНКИ + АДМИН) ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message.text;

    // Админка
    if (msg === '/admin' && userId === ADMIN_ID) {
        return ctx.reply('👑 Админка', Markup.inlineKeyboard([
            [Markup.button.callback('📊 Статистика', 'adm_stats')],
            [Markup.button.callback('📝 Текст приветствия', 'adm_edit_text')],
            [Markup.button.callback('🖼 Фото приветствия', 'adm_edit_photo')]
        ]));
    }

    const settingsSnap = await db.ref('settings').once('value');
    const settings = settingsSnap.val() || {};

    // Состояние ожидания для админа
    if (userId === ADMIN_ID && settings.waiting) {
        if (settings.waiting === 'text') {
            await db.ref('settings').update({ welcome_text: msg, waiting: null });
            return ctx.reply("✅ Текст приветствия успешно обновлен!");
        }
    }

    const userSnap = await db.ref(`users/${userId}`).once('value');
    const userData = userSnap.val() || {};
    
    // Простая проверка уровня
    if (!userData.level) return ctx.reply("Сначала нажми /start и выбери уровень ума!");

    // Логика лимитов (20 запросов)
    const today = new Date().toISOString().split('T')[0];
    if (userData.last_date !== today) {
        await db.ref(`users/${userId}`).update({ count: 0, last_date: today });
        userData.count = 0;
    }
    if ((userData.count || 0) >= 20 && userId !== ADMIN_ID) {
        return ctx.reply("🛑 Твой лимит на сегодня (20/20) исчерпан. Жду тебя завтра!");
    }

    const wait = await ctx.reply("⏳ Нейро Бро думает...");

    // --- ГЕНЕРАЦИЯ КАРТИНОК (ПРАВИЛЬНАЯ) ---
    const imageKeywords = ["нарисуй", "нарисуй мне", "фото", "picture of", "draw"];
    const isImageRequest = imageKeywords.some(keyword => msg.toLowerCase().startsWith(keyword));

    if (isImageRequest) {
        try {
            // Очищаем промпт от ключевых слов
            let prompt = msg;
            imageKeywords.forEach(k => prompt = prompt.replace(new RegExp(`^${k}`, 'i'), '').trim());
            
            if (!prompt) {
                await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, "А что нарисовать? Напиши, например: нарисуй собаку в космосе.");
                return;
            }

            const imageUrl = `https://pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${Math.floor(Math.random() * 100000)}&nofeed=true`;
            
            // Сначала удаляем сообщение "Думаю"
            await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id);
            
            // Отправляем фото
            await ctx.replyWithPhoto(imageUrl, { caption: `🎨 Готово! Запрос: ${prompt}` });
            return await db.ref(`users/${userId}`).update({ count: (userData.count || 0) + 1 });
        } catch (e) {
            await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, "❌ Ошибка при рисовании. Попробуй позже.");
            return;
        }
    }

    // --- ТЕКСТОВЫЙ ОТВЕТ (GEMINI ИСПРАВЛЕННЫЙ) ---
    try {
        const fullPrompt = `${systemPrompts[userData.level] || systemPrompts['think']}\nПользователь: ${msg}`;
        const result = await model.generateContent(fullPrompt);
        
        // Надежное получение текста
        const aiResponseText = result.response.text();
        
        if (!aiResponseText || aiResponseText.trim() === "") {
            throw new Error("Empty AI response");
        }

        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, aiResponseText);
        await db.ref(`users/${userId}`).update({ count: (userData.count || 0) + 1 });
    } catch (e) {
        console.error("Gemini Error:", e);
        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, "❌ К сожалению, ИИ сейчас не смог ответить. Попробуй позже.");
    }
});

// Обработка фото для админки
bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const settings = (await db.ref('settings').once('value')).val() || {};
    if (settings.waiting === 'photo') {
        // Берем ID самой большой версии фото
        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await db.ref('settings').update({ welcome_photo: photoId, waiting: null });
        ctx.reply("✅ Фото приветствия успешно обновлено!");
    }
});

// --- КНОПКИ АДМИНА ---
bot.action('adm_stats', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const snap = await db.ref('users').once('value');
    const count = Object.keys(snap.val() || {}).length;
    await ctx.answerCbQuery();
    ctx.reply(`👥 Всего пользователей в базе: ${count}`);
});

bot.action('adm_edit_text', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await db.ref('settings').update({ waiting: 'text' });
    await ctx.answerCbQuery();
    ctx.reply("Пришли новый текст приветствия (используй {name} для имени):");
});

bot.action('adm_edit_photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await db.ref('settings').update({ waiting: 'photo' });
    await ctx.answerCbQuery();
    ctx.reply("Пришли новое фото для приветствия:");
});

console.log("✅ Бот запускается...");
bot.launch()
  .then(() => console.log("✅ Бот успешно подключен к Telegram!"))
  .catch((err) => console.error("❌ Ошибка запуска:", err));
