const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');

// --- КОНФИГУРАЦИЯ ---
const BOT_TOKEN = process.env.BOT_TOKEN || '8547861356:AAHV1gpk7UzpQKjHXS6csnXXqXRr9GZ-M2c';
const ADMIN_ID = 7040863301;
const DB_URL = "https://dogx-base-default-rtdb.firebaseio.com";

// Ключи (берем из системы)
const keys = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2].filter(k => k);
let currentKeyIndex = 0;

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
    }
} catch (e) { console.error("Firebase Error:", e.message); }

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const app = express();
app.get('/', (req, res) => res.send('Neuro Bro Double-Gemini Engine Active!'));
app.listen(process.env.PORT || 3000);

// Настройки безопасности Gemini
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Функция переключения ключей при ошибке
function getModel() {
    const key = keys[currentKeyIndex];
    if (!key) return null;
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({ model: "gemini-1.5-flash", safetySettings });
}

// --- КОМАНДА СТАРТ ---
bot.start(async (ctx) => {
    const name = ctx.from.first_name || 'Бро';
    if (db) await db.ref(`users/${ctx.from.id}`).update({ name, username: ctx.from.username || 'none' });
    
    ctx.reply(`Привет, ${name}! 👋 Я твой мощный ИИ-бро. \n\nСистема: Gemini Double-Core (бесплатно).\nПиши запрос или "нарисуй [что-то]".`, 
        Markup.inlineKeyboard([[Markup.button.callback("Выбрать режим ⚙️", 'setup')]])
    );
});

bot.action('setup', (ctx) => {
    ctx.reply('Выбери режим работы:', Markup.inlineKeyboard([
        [Markup.button.callback('⚡️ Быстрый', 'set_fast')],
        [Markup.button.callback('🧠 Подробный', 'set_think')],
        [Markup.button.callback('💎 Эксперт (Код)', 'set_pro')]
    ]));
});

bot.action(/^set_(.+)$/, async (ctx) => {
    const level = ctx.match[1];
    if (db) await db.ref(`users/${ctx.from.id}`).update({ level });
    ctx.reply(`Режим "${level}" включен!`);
});

// --- ГЛАВНАЯ ЛОГИКА ---
bot.on('text', async (ctx) => {
    const msg = ctx.message.text;
    if (msg.startsWith('/')) return;

    const wait = await ctx.reply("⏳ Нейро Бро думает...");

    // Рисование
    if (msg.toLowerCase().includes("нарисуй")) {
        const prompt = msg.replace(/нарисуй/gi, "").trim();
        const url = `https://pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${Date.now()}`;
        return ctx.replyWithPhoto(url, { caption: `🎨 Готово: ${prompt}` }).then(() => ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id));
    }

    // Текстовый ответ с ротацией ключей
    let success = false;
    let attempts = 0;

    while (!success && attempts < keys.length) {
        try {
            const model = getModel();
            if (!model) throw new Error("Ключи не настроены!");

            const result = await model.generateContent(msg);
            const responseText = result.response.text();

            await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, responseText);
            success = true;
        } catch (e) {
            console.warn(`Ключ ${currentKeyIndex + 1} упал, пробую следующий...`);
            currentKeyIndex = (currentKeyIndex + 1) % keys.length;
            attempts++;
            if (attempts === keys.length) {
                await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, "❌ Все ключи перегружены или неверны. Попробуй позже.");
            }
        }
    }
});

bot.launch().then(() => console.log("🚀 Бот запущен на двух ядрах Gemini!"));
