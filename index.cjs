// Glimmer Cafe bot — welcomes, slower leveling, streaks, role rewards, public menu
// Requires: npm i discord.js dotenv
const {
  Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder,
  ActivityType, PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- ENV / Config ---
const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const welcomeChannelId = process.env.WELCOME_CHANNEL_ID;
const levelsChannelId = process.env.LEVELS_CHANNEL_ID; // where level-up messages go
const xpCooldownSec = parseInt(process.env.XP_COOLDOWN_SEC || '90', 10); // slower default

// --- Client with required intents ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // welcomes + member count
    GatewayIntentBits.GuildMessages,  // XP on messages
    GatewayIntentBits.MessageContent  // read content for XP trigger
  ],
});

// --- Simple JSON "database" for XP + streaks ---
const DATA_FILE = path.join(__dirname, 'xp-data.json');
let db = { guilds: {} };
function loadDb() { try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { console.error('Could not load DB:', e); } }
function saveDb() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('Could not save DB:', e); } }
loadDb();
setInterval(saveDb, 30_000);

// --- Leveling removed: keep only level number for role rewards ---
function xpForNext(level) { return 0; }
function ensureUser(gId, uId) {
  if (!db.guilds[gId]) db.guilds[gId] = {};
  if (!db.guilds[gId][uId]) {
    db.guilds[gId][uId] = {
      xp: 0, // retained for backward compatibility; no longer used
      level: 0,
      lastDaily: 0,         // ms timestamp of last daily claim
      lastDailyDay: null,   // integer day index for streak logic
      streakCount: 0,
      streakItem: null      // key of chosen item
    };
  }
  // Initialize minigame wins container if missing
  const u = db.guilds[gId][uId];
  if (!u.wins) u.wins = { total: 0, snack: 0, cider: 0, trivia: 0, jumble: 0, heist: 0 };
  if (!u.points) u.points = { total: 0, snack: 0, cider: 0, trivia: 0, jumble: 0, heist: 0 };
  // Birthday + mute restore state holders
  if (!u.birthday) u.birthday = { month: null, day: null, lastYearCelebrated: null };
  if (!u.preMuteRoles) u.preMuteRoles = null;
  return db.guilds[gId][uId];
}
function totalXpOf(u) { return 0; }
function progressBar() { return ''; }
function awardXp() { return { leveled: false, before: 0, after: 0 }; }
const DAY = 24 * 60 * 60 * 1000;
// Daily reset offset in minutes relative to UTC (e.g., -300 for EST standard time).
// Default 0 means reset at UTC midnight.
const dailyUtcOffsetMinutes = parseInt(process.env.DAILY_UTC_OFFSET_MINUTES || '0', 10);
const dayIndexDaily = (ms) => Math.floor((ms + dailyUtcOffsetMinutes * 60_000) / DAY);

function hasGenerosityRole(member) {
  return member?.roles?.cache?.some(r => r.name === 'Element of Generosity') || false;
}

function parseDurationToMs(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * units[unit];
}

// --- Role rewards by name (Arcane levels) ---
const roleRewards = {
  1:  'Member',
  3:  'New Patron',
  5:  'Sugarcube Sipper',
  10: 'Cocoa Companion',
  15: 'Latte Luminary',
  20: 'Pancake Paladin',
  25: 'Caramel Conjurer',
  30: 'Mocha Maestro',
  35: 'Crystal Creamer',
  40: 'Harmony Brewer',
  45: 'Starlight Barista',
  50: 'Aurora Artisan',
  60: 'Prism Pâtissier',
  70: 'Moonbeam Maitre d\'',
  80: 'Sunlit Sommelier',
  90: 'Enchanted Espresso',
  100: 'Celestial Connoisseur',
};

// --- Streak milestone roles ---
const streakRoleRewards = {
  3:  'Dawn Drip',
  7:  'Weeklong Whisk',
  14: 'Fortnight Foam',
  30: 'Moonlit Macchiato',
  60: 'Celestial Siphon',
};

// --- Minigame winner roles (based on total wins) ---
const winnerRoleRewards = {
  1:  'Game Initiate',
  5:  'Quiz Connoisseur',
  10: 'Arcade Aficionado',
  25: 'Friendship Champion',
  50: 'Equestrian Legend',
};

// --- Minigame-specific role rewards ---
const minigameRoleRewards = {
  snack: {
    50:  'Snack Sleuth',
    150:  'Candy Connoisseur',
    300: 'Snack Legend'
  },
  cider: {
    50:  'Cider Squeezer',
    150:  'Apple Ace',
    300: 'Press Legend'
  },
  trivia: {
    50:  'Quiz Rookie',
    150:  'Knowledge Keeper',
    300: 'Trivia Titan'
  },
  jumble: {
    50:  'Word Weaver',
    150:  'Puzzle Pro',
    300: 'Word Wizard'
  },
  heist: {
    50:  'Cookie Cutter',
    150:  'Caper Captain',
    300: 'Cookie King'
  }
};

// --- Placeholder role for activity ---
const PLACEHOLDER_ROLE = 'ㅤㅤㅤㅤㅤㅤㅤㅤSTREAK/MINIGAMEㅤㅤㅤㅤㅤㅤㅤ';
async function applyLevelRewards(member, prevLevel, newLevel) {
  const thresholds = Object.keys(roleRewards).map(n => parseInt(n, 10)).sort((a,b)=>a-b);
  for (const L of thresholds) {
    if (L > prevLevel && L <= newLevel) {
      const roleName = roleRewards[L];
      const role = member.guild.roles.cache.find(r => r.name === roleName)
        || await member.guild.roles.fetch().then(col => col.find(r => r.name === roleName)).catch(() => null);
      if (role && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Reached level ${L}`).catch(e => console.log('Role add failed:', e.message));
      } else if (!role) {
        console.log(`Role not found: "${roleName}" — create it and make sure the bot's role is above it.`);
      }
    }
  }

  // Also grant separator roles and Member upon first reaching level 1
  if (prevLevel < 1 && newLevel >= 1) {
    const separatorRoleNames = [
      "ㅤㅤㅤㅤㅤㅤㅤㅤㅤFAVORITE PONYㅤㅤㅤㅤㅤㅤㅤㅤ",
      "ㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤRANKSㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ",
      "ㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤRACEㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ",
      "ㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤPINGㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ",
      "ㅤㅤㅤㅤㅤㅤㅤㅤㅤ  ㅤVANITYㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ",
      "Member",
    ];
    for (const roleName of separatorRoleNames) {
      try {
        const role = member.guild.roles.cache.find(r => r.name === roleName)
          || await member.guild.roles.fetch().then(col => col.find(r => r.name === roleName)).catch(() => null);
        if (role && !member.roles.cache.has(role.id)) {
          await member.roles.add(role, 'Reached level 1');
        } else if (!role) {
          console.log(`Role not found: "${roleName}" — make sure it exists and bot is above it.`);
        }
      } catch (e) {
        console.log('Role add failed:', e.message);
      }
    }
  }
}

async function applyStreakRewards(member, prevStreak, newStreak) {
  const thresholds = Object.keys(streakRoleRewards).map(n => parseInt(n, 10)).sort((a,b)=>a-b);
  for (const S of thresholds) {
    if (S > prevStreak && S <= newStreak) {
      const roleName = streakRoleRewards[S];
      const role = member.guild.roles.cache.find(r => r.name === roleName)
        || await member.guild.roles.fetch().then(col => col.find(r => r.name === roleName)).catch(() => null);
      if (role && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Reached ${S} day streak`).catch(e => console.log('Streak role add failed:', e.message));
      } else if (!role) {
        console.log(`Streak role not found: "${roleName}" — create it and make sure the bot's role is above it.`);
      }
    }
  }
}

async function applyWinnerRewards(member, prevTotalWins, newTotalWins) {
  const thresholds = Object.keys(winnerRoleRewards).map(n => parseInt(n, 10)).sort((a,b)=>a-b);
  for (const T of thresholds) {
    if (T > prevTotalWins && T <= newTotalWins) {
      const roleName = winnerRoleRewards[T];
      const role = member.guild.roles.cache.find(r => r.name === roleName)
        || await member.guild.roles.fetch().then(col => col.find(r => r.name === roleName)).catch(() => null);
      if (role && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Reached ${T} total minigame wins`).catch(e => console.log('Winner role add failed:', e.message));
      } else if (!role) {
        console.log(`Winner role not found: "${roleName}" — create it and make sure the bot's role is above it.`);
      }
    }
  }
}

// --- Point system and minigame role rewards ---
async function awardPoints(guild, userId, gameKey) {
  const u = ensureUser(guild.id, userId);
  if (!u.points) u.points = { total: 0, snack: 0, cider: 0, trivia: 0, jumble: 0, heist: 0 };
  if (!(gameKey in u.points)) u.points[gameKey] = 0;
  
  // Award points based on game type
  const pointValues = {
    snack: 10,
    cider: 15,
    trivia: 12,
    jumble: 8,
    heist: 20
  };
  
  const points = pointValues[gameKey] || 10;
  u.points[gameKey] += points;
  u.points.total += points;
  saveDb();
  
  // Apply minigame-specific role rewards
  try {
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
    await applyMinigameRoleRewards(member, gameKey, u.points[gameKey]);
    await grantPlaceholderRole(member);
  } catch (e) {
    console.log('awardPoints error:', e?.message || e);
  }
  
  return points;
}

async function applyMinigameRoleRewards(member, gameKey, currentWins) {
  const gameRoles = minigameRoleRewards[gameKey];
  if (!gameRoles) return;
  
  const thresholds = Object.keys(gameRoles).map(n => parseInt(n, 10)).sort((a,b)=>a-b);
  for (const W of thresholds) {
    if (currentWins >= W) {
      const roleName = gameRoles[W];
      const role = member.guild.roles.cache.find(r => r.name === roleName)
        || await member.guild.roles.fetch().then(col => col.find(r => r.name === roleName)).catch(() => null);
      if (role && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Reached ${W} ${gameKey} wins`).catch(e => console.log('Minigame role add failed:', e.message));
      } else if (!role) {
        console.log(`Minigame role not found: "${roleName}" — create it and make sure the bot's role is above it.`);
      }
    }
  }
}

async function grantPlaceholderRole(member) {
  try {
    const role = member.guild.roles.cache.find(r => r.name === PLACEHOLDER_ROLE)
      || await member.guild.roles.fetch().then(col => col.find(r => r.name === PLACEHOLDER_ROLE)).catch(() => null);
    if (role && !member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'Active in minigames or daily streak').catch(e => console.log('Placeholder role add failed:', e.message));
    } else if (!role) {
      console.log(`Placeholder role not found: "${PLACEHOLDER_ROLE}" — create it and make sure the bot's role is above it.`);
    }
  } catch (e) {
    console.log('grantPlaceholderRole error:', e?.message || e);
  }
}

function getHighestMinigameRole(user) {
  const u = ensureUser(user.guild.id, user.id);
  if (!u.wins) return 'No roles yet';
  
  let highestRole = 'No roles yet';
  let highestLevel = 0;
  
  for (const [gameKey, gameRoles] of Object.entries(minigameRoleRewards)) {
    const wins = u.wins[gameKey] || 0;
    const thresholds = Object.keys(gameRoles).map(n => parseInt(n, 10)).sort((a,b)=>b-a); // Descending order
    for (const threshold of thresholds) {
      if (wins >= threshold) {
        if (threshold > highestLevel) {
          highestLevel = threshold;
          highestRole = gameRoles[threshold];
        }
        break;
      }
    }
  }
  
  return highestRole;
}

// --- AI Chat System ---
// Note: userMemories are now stored in the database for cloud hosting compatibility

async function generateAIResponse(userId, message, guildId) {
  // Input validation
  if (!userId || !message || !guildId) {
    console.error('Invalid parameters for generateAIResponse:', { userId, message, guildId });
    return "Sorry, I'm having trouble understanding your request. Please try again! ☕";
  }
  
  // Sanitize message length
  if (message.length > 1000) {
    message = message.substring(0, 1000) + "...";
  }
  
  // Get user data and ensure AI memory exists
  const u = ensureUser(guildId, userId);
  if (!u.aiMemory) {
    u.aiMemory = [];
  }
  
  const userMemory = u.aiMemory;
  
  // Add user message to memory
  userMemory.push({ role: 'user', content: message });
  
  // Keep only last 10 messages to prevent memory overflow
  if (userMemory.length > 10) {
    userMemory.splice(0, userMemory.length - 10);
  }
  
  // Save memory to database
  saveDb();
  
  // Create system prompt for Glimmer AI
  const systemPrompt = `You are Glimmer, a friendly AI assistant from the Glimmer Cafe Discord server. You're knowledgeable about My Little Pony: Friendship is Magic and love helping users with questions about the show, the cafe, minigames, and general chat. You're cheerful, helpful, and use pony-themed language occasionally. Keep responses concise but friendly.`;
  
  // Create messages array for API call
  const messages = [
    { role: 'system', content: systemPrompt },
    ...userMemory.slice(-8) // Include last 8 messages for context
  ];
  
  try {
    // For now, we'll use a simple response system since we don't have an AI API key
    // In a real implementation, you'd call an AI API like OpenAI here
    const response = generateSimpleResponse(message, userMemory);
    
    // Add AI response to memory
    userMemory.push({ role: 'assistant', content: response });
    
    // Save updated memory to database
    saveDb();
    
    return response;
  } catch (error) {
    console.error('AI Response generation error:', error);
    // Log additional details for cloud debugging
    console.error('Error details:', {
      userId,
      guildId,
      messageLength: message.length,
      memoryLength: userMemory.length,
      error: error.message
    });
    return "Sorry, I'm having trouble thinking right now. Maybe try again later! ☕";
  }
}

function generateSimpleResponse(message, userMemory) {
  const lowerMessage = message.toLowerCase();
  
  // Greeting responses
  if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey')) {
    return "Hello there! Welcome to Glimmer Cafe! ☕ How can I help you today?";
  }
  
  // Goodbye responses
  if (lowerMessage.includes('bye') || lowerMessage.includes('goodbye') || lowerMessage.includes('see you')) {
    return "Goodbye! Thanks for visiting Glimmer Cafe! Come back soon! ☕✨";
  }
  
  // MLP-related responses
  if (lowerMessage.includes('pony') || lowerMessage.includes('mlp') || lowerMessage.includes('friendship is magic')) {
    return "I love talking about My Little Pony! What's your favorite character or episode? The show teaches us so much about friendship! 🌈";
  }
  
  if (lowerMessage.includes('twilight') || lowerMessage.includes('sparkle')) {
    return "Twilight Sparkle is such a wonderful character! She's grown so much from a bookish unicorn to a Princess of Friendship! 📚✨";
  }
  
  if (lowerMessage.includes('rainbow dash')) {
    return "Rainbow Dash is awesome! 20% cooler than any other pony! 🌈⚡";
  }
  
  if (lowerMessage.includes('pinkie pie')) {
    return "Pinkie Pie always knows how to make everypony smile! She's the life of the party! 🎉🎂";
  }
  
  if (lowerMessage.includes('applejack')) {
    return "Applejack is the most honest pony in Equestria! She works hard on Sweet Apple Acres! 🍎";
  }
  
  if (lowerMessage.includes('rarity')) {
    return "Rarity is so generous and stylish! She runs the Carousel Boutique with such elegance! 💎✨";
  }
  
  if (lowerMessage.includes('fluttershy')) {
    return "Fluttershy is so kind and gentle with animals! She has such a big heart! 🦋💕";
  }
  
  // Cafe-related responses
  if (lowerMessage.includes('cafe') || lowerMessage.includes('coffee') || lowerMessage.includes('drink')) {
    return "Welcome to Glimmer Cafe! We have all sorts of delicious drinks and treats! Try using /menu to see what we offer! ☕🍰";
  }
  
  if (lowerMessage.includes('menu') || lowerMessage.includes('order')) {
    return "You can use /menu or /order to see our full menu! We have everything from lattes to cupcakes! 🧁☕";
  }
  
  // Minigame responses
  if (lowerMessage.includes('game') || lowerMessage.includes('minigame') || lowerMessage.includes('play')) {
    return "We have lots of fun minigames! Try /game help to see them all! You can play trivia, jumble, heist, and more! 🎮";
  }
  
  if (lowerMessage.includes('trivia') || lowerMessage.includes('quiz')) {
    return "The Friendship Quiz is so much fun! Use /game trivia to test your MLP knowledge! 🧠✨";
  }
  
  if (lowerMessage.includes('jumble') || lowerMessage.includes('word')) {
    return "Cutie Mark Jumble is a great word game! Use /game jumble to unscramble pony names and places! 🔤";
  }
  
  if (lowerMessage.includes('heist') || lowerMessage.includes('cookie')) {
    return "The Cookie Caper is a team heist game! Use /game heist to join forces with other ponies! 🍪👥";
  }
  
  if (lowerMessage.includes('cider') || lowerMessage.includes('press')) {
    return "Cider Press Showdown is a fast-paced duel! Use /game cider @user to challenge someone! 🍎⚡";
  }
  
  if (lowerMessage.includes('snack') || lowerMessage.includes('guess')) {
    return "Who's Snack Is It Anyway is a guessing game! Use /game snack to guess ponies from hints! 🍰";
  }
  
  // Points and roles
  if (lowerMessage.includes('point') || lowerMessage.includes('score') || lowerMessage.includes('leaderboard')) {
    return "You can check your points with /points show! Play minigames to earn points and unlock special roles! 🏆";
  }
  
  if (lowerMessage.includes('role') || lowerMessage.includes('rank')) {
    return "We have special roles for different minigames! Play games to unlock roles like Snack Sleuth, Quiz Rookie, and more! 🎖️";
  }
  
  // Daily and streak
  if (lowerMessage.includes('daily') || lowerMessage.includes('streak')) {
    return "Don't forget to claim your daily with /daily! You can set your favorite item and build up a streak! 📅✨";
  }
  
  // Help responses
  if (lowerMessage.includes('help') || lowerMessage.includes('command')) {
    return "I can help you with lots of things! Try /menu for drinks, /game help for minigames, /points show for your stats, or just chat with me! 💬";
  }
  
  // Thank you responses
  if (lowerMessage.includes('thank') || lowerMessage.includes('thanks')) {
    return "You're very welcome! I'm always happy to help! That's what friendship is all about! 💕";
  }
  
  // Compliment responses
  if (lowerMessage.includes('awesome') || lowerMessage.includes('great') || lowerMessage.includes('cool') || lowerMessage.includes('amazing')) {
    return "Aww, thank you! You're pretty awesome too! ✨";
  }
  
  // Weather responses
  if (lowerMessage.includes('weather') || lowerMessage.includes('rain') || lowerMessage.includes('sunny')) {
    return "The weather team in Cloudsdale does such a great job! Though sometimes they need a little help from Rainbow Dash! ☁️🌈";
  }
  
  // Magic responses
  if (lowerMessage.includes('magic') || lowerMessage.includes('spell') || lowerMessage.includes('unicorn')) {
    return "Magic is everywhere in Equestria! From unicorn spells to the magic of friendship! ✨🦄";
  }
  
  // Friendship responses
  if (lowerMessage.includes('friend') || lowerMessage.includes('friendship')) {
    return "Friendship is the most powerful magic of all! It's what makes our world go round! 💕✨";
  }
  
  // Default responses
  const defaultResponses = [
    "That's interesting! Tell me more! 💭",
    "I love chatting with you! What else is on your mind? 💬",
    "That sounds fun! I'm always here to chat! ☕",
    "Thanks for sharing that with me! What would you like to talk about? 🌟",
    "I'm here to help! Is there anything specific you'd like to know about? 🤔",
    "That's a great question! Let me think about that... 💭",
    "I love our conversations! What else can I help you with? 💕",
    "You always have such interesting things to say! Tell me more! ✨"
  ];
  
  return defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
}

function clearUserMemory(userId, guildId) {
  const u = ensureUser(guildId, userId);
  u.aiMemory = [];
  saveDb();
}

// --- Cafe menu items (24 items) ---
function menuItems() {
  return {
    latte:        { label: 'Latte',          emoji: '☕',  color: 0xF1C40F, text: 'A warm, creamy latte for {user}!' },
    cocoa:        { label: 'Hot Cocoa',      emoji: '🍫',  color: 0x8E44AD, text: 'Hot cocoa with marshmallows for {user}!' },
    pancake:      { label: 'Pancakes',       emoji: '🥞',  color: 0xE67E22, text: 'A stack of syrupy pancakes for {user}!' },
    tea:          { label: 'Tea',            emoji: '🫖',  color: 0x2ECC71, text: 'A soothing pot of tea for {user}!' },
    green_tea:    { label: 'Green Tea',      emoji: '🍵',  color: 0x2ECC71, text: 'Fresh green tea for {user}!' },
    matcha:       { label: 'Matcha Latte',   emoji: '🍵',  color: 0x66BB6A, text: 'A whisked matcha latte for {user}!' },
    chai:         { label: 'Chai',           emoji: '🫖',  color: 0xD4A373, text: 'Spiced chai for {user}!' },
    iced_tea:     { label: 'Iced Tea',       emoji: '🧋',  color: 0x1ABC9C, text: 'Chilled iced tea for {user}!' },
    lemonade:     { label: 'Lemonade',       emoji: '🍋',  color: 0xF7DC6F, text: 'Zesty lemonade for {user}!' },
    smoothie:     { label: 'Smoothie',       emoji: '🍓',  color: 0xFF6B6B, text: 'A fruity smoothie for {user}!' },
    milkshake:    { label: 'Milkshake',      emoji: '🥤',  color: 0xF1948A, text: 'A thick milkshake for {user}!' },
    espresso:     { label: 'Espresso',       emoji: '☕',  color: 0x6D4C41, text: 'A bold espresso for {user}!' },
    cappuccino:   { label: 'Cappuccino',     emoji: '☕',  color: 0xA1887F, text: 'Foamy cappuccino for {user}!' },
    macchiato:    { label: 'Macchiato',      emoji: '☕',  color: 0xA0522D, text: 'A caramel-kissed macchiato for {user}!' },
    americano:    { label: 'Americano',      emoji: '☕',  color: 0x5D4037, text: 'A smooth americano for {user}!' },
    mocha:        { label: 'Mocha',          emoji: '🍫',  color: 0x8D6E63, text: 'Chocolatey mocha for {user}!' },
    flat_white:   { label: 'Flat White',     emoji: '☕',  color: 0xBCAAA4, text: 'Silky flat white for {user}!' },
    donut:        { label: 'Donut',          emoji: '🍩',  color: 0xE91E63, text: 'A fresh donut for {user}!' },
    muffin:       { label: 'Muffin',         emoji: '🧁',  color: 0x9B59B6, text: 'A blueberry muffin for {user}!' },
    cupcake:      { label: 'Cupcake',        emoji: '🧁',  color: 0xFFB6C1, text: 'A glittery cupcake for {user}!' },
    croissant:    { label: 'Croissant',      emoji: '🥐',  color: 0xF5CBA7, text: 'A buttery croissant for {user}!' },
    waffle:       { label: 'Waffle',         emoji: '🧇',  color: 0xD35400, text: 'A crispy waffle for {user}!' },
    brownie:      { label: 'Brownie',        emoji: '🍫',  color: 0x8E6E53, text: 'A fudgy brownie for {user}!' },
    cookie:       { label: 'Cookie',         emoji: '🍪',  color: 0xD2691E, text: 'A fresh-baked cookie for {user}!' },
  };
}
// --- Minigame helpers ---
function pickTriviaQuestion() {
  const questions = [
    // Advanced lore, production, and continuity
    { question: "Which background pony gained a canonical name via a fandom in-joke acknowledged by DHX in S2E18 credits?", choices: ["A) Bon Bon","B) Derpy Hooves","C) Lyra Heartstrings","D) Doctor Hooves"], answer: 'B' },
    { question: "What is the full artifact name housed by the Crystal Empire that protects it from the Frozen North?", choices: ["A) Crystal Heart","B) Heart of Harmony","C) Prism Heart","D) Heart of Equestria"], answer: 'A' },
    { question: "Which episode first features the Map (Cutie Map) sending ponies on friendship missions?", choices: ["A) S5E1-2","B) S4E26","C) S6E1-2","D) S5E10"], answer: 'A' },
    { question: "Which Wonderbolt uses the callsign 'Rapidfire' in show canon?", choices: ["A) Soarin","B) Rapidfire","C) Fleetfoot","D) High Winds"], answer: 'B' },
    { question: "Sunburst hails from which location prior to moving to the Crystal Empire?", choices: ["A) Canterlot","B) Sire's Hollow","C) Manehattan","D) Vanhoover"], answer: 'B' },
    { question: "Which creature is NOT a member of the Council of Friendship after S9?", choices: ["A) Spike","B) Discord","C) Applejack","D) Fluttershy"], answer: 'B' },
    { question: "What is the real EUP division name that predated the Wonderbolts historically?", choices: ["A) Sky Guard","B) Royal Pegasus Corps","C) EUP Guard—First Aerial Division","D) Cloudsdale Elite"], answer: 'C' },
    { question: "Which Season 2 episode first shows Cadance's signature greeting with Twilight ('Sunshine, sunshine…')?", choices: ["A) S2E25","B) S2E24","C) S2E3","D) S2E13"], answer: 'A' },
    { question: "Who voiced Discord in Friendship is Magic?", choices: ["A) John de Lancie","B) Mark Acheson","C) Peter New","D) Andrew Francis"], answer: 'A' },
    { question: "Which episode resolves Starlight Glimmer's village arc via cutie mark vault destruction?", choices: ["A) The Cutie Map","B) The Cutie Re-Mark","C) Every Little Thing She Does","D) Cutie Markless"], answer: 'A' },
    { question: "What is the Tree of Harmony's school counterpart created by the Young Six?", choices: ["A) Harmony Grove","B) Treehouse of Harmony","C) Grove of Bonds","D) Friendship Arbor"], answer: 'B' },
    { question: "What is the proper species name for Thorax and Ocellus after reformation?", choices: ["A) Neo-changelings","B) Reformed changelings","C) True-changelings","D) Harmonic changelings"], answer: 'B' },
    { question: "Which episode first shows the Pillars of Equestria as a group?", choices: ["A) Shadow Play","B) Campfire Tales","C) Daring Done?","D) Uncommon Bond"], answer: 'A' },
    { question: "What artifact did Twilight use to time travel in 'It's About Time'?", choices: ["A) Starswirl's Mirror","B) Starswirl's Time Spell","C) Alicorn Amulet","D) Hourglass of Canterlot"], answer: 'B' },
    { question: "Which student of friendship is a yak?", choices: ["A) Gallus","B) Smolder","C) Yona","D) Sandbar"], answer: 'C' },
    { question: "Who composed the original Friendship is Magic theme arrangement?", choices: ["A) Daniel Ingram","B) William Anderson","C) Steffan Andrews","D) Rebecca Shoichet"], answer: 'A' },
    { question: "Which object did Twilight use to absorb Tirek's magic clash in S4's finale?", choices: ["A) Mirror Pool","B) Rainbow Power focus","C) Box of Harmony Keys","D) Star Swirl Nexus"], answer: 'B' },
    { question: "Which city do the hippogriffs/seaponies primarily inhabit post-Storm King?", choices: ["A) Hippogriffia","B) Mount Aris","C) Seaquestria","D) Aris Reef"], answer: 'B' },
    { question: "What was the in-universe title of Daring Do's author persona?", choices: ["A) A.K. Yearling","B) A.K. Yearly","C) A.K. Yearbook","D) A.K. Yerling"], answer: 'A' },
    { question: "Which villain trio was turned to stone at the end of Season 9?", choices: ["A) Chrysalis, Sombra, Tirek","B) Cozy Glow, Grogar, Tirek","C) Chrysalis, Cozy Glow, Tirek","D) Chrysalis, Discord, Sombra"], answer: 'C' },
    { question: "Which episode brings Cheese Sandwich back for Pinkie's character arc closure?", choices: ["A) Pinkie Pride","B) The Last Laugh","C) Maud Couple","D) Secrets and Pies"], answer: 'B' },
    { question: "What is the Cutie Mark Crusaders' official mark motif after earning their cutie marks?", choices: ["A) Shield with star and horseshoe","B) Shield with wing, apple, and musical note","C) Shield with star, apple, and lightning","D) Shield with heart, apple, and treble clef"], answer: 'B' },
    { question: "Which artifact was central to 'The Journal of the Two Sisters' lore tie-in?", choices: ["A) Alicorn Amulet","B) Elements of Harmony","C) Time Turner","D) Siren Gems"], answer: 'B' },
    { question: "Which Season introduced the School of Friendship?", choices: ["A) S6","B) S7","C) S8","D) S9"], answer: 'C' }
  ];
  return questions[Math.floor(Math.random() * questions.length)];
}
function pickJumbleWord() {
  const words = [
    // Locations
    'Ponyville', 'Canterlot', 'Cloudsdale', 'Manehattan', 'Crystal Empire', 'Everfree Forest', 'Sweet Apple Acres', 'Sugarcube Corner',
    'Carousel Boutique', 'Golden Oak Library', 'Town Hall', 'School of Friendship', 'Royal Castle', 'Crystal Castle', 'Ponyville Hospital',
    
    // Characters (Mane 6)
    'Twilight Sparkle', 'Rainbow Dash', 'Pinkie Pie', 'Applejack', 'Rarity', 'Fluttershy',
    
    // Princesses & Royalty
    'Princess Celestia', 'Princess Luna', 'Princess Cadance', 'Princess Twilight', 'Flurry Heart', 'Shining Armor',
    
    // Cutie Mark Crusaders
    'Apple Bloom', 'Sweetie Belle', 'Scootaloo',
    
    // Secondary Characters
    'Starlight Glimmer', 'Sunset Shimmer', 'Trixie', 'Spike', 'Discord', 'Zecora', 'Big McIntosh', 'Granny Smith',
    'Cheese Sandwich', 'Derpy Hooves', 'Lyra Heartstrings', 'Bon Bon', 'Octavia Melody', 'DJ Pon-3', 'Doctor Hooves',
    'Berry Punch', 'Maud Pie', 'Marble Pie', 'Limestone Pie', 'Tempest Shadow', 'Thorax', 'Pharynx',
    
    // School of Friendship Students
    'Gallus', 'Smolder', 'Ocellus', 'Silverstream', 'Yona', 'Sandbar',
    
    // Villains
    'Queen Chrysalis', 'King Sombra', 'Lord Tirek', 'Cozy Glow', 'Nightmare Moon', 'Storm King',
    
    // Groups & Organizations
    'Wonderbolts', 'Cutie Mark Crusaders', 'Royal Guard', 'Shadowbolts', 'Young Six', 'Mane Six',
    
    // Items & Artifacts
    'Elements of Harmony', 'Cutie Mark', 'Sonic Rainboom', 'Magic of Friendship', 'Crystal Heart', 'Tree of Harmony',
    'Map of Harmony', 'Rainbow Power', 'Mane Six', 'Cutie Mark Crusaders', 'Friendship School',
    
    // Songs & Episodes
    'Winter Wrap Up', 'Smile Song', 'Friendship is Magic', 'Equestria Girls', 'My Little Pony',
    
    // Special Terms
    'Alicorn', 'Unicorn', 'Pegasus', 'Earth Pony', 'Changeling', 'Griffon', 'Dragon', 'Hippogriff', 'Yak',
    'Cutie Mark', 'Cutie Mark Crusaders', 'Friendship', 'Magic', 'Harmony', 'Rainbow', 'Crystal', 'Royal',
    
    // Places & Landmarks
    'Ponyville Library', 'Canterlot Castle', 'Cloudsdale Weather Factory', 'Crystal Empire Throne Room',
    'Everfree Forest Castle', 'Sugarcube Corner Bakery', 'Carousel Boutique Shop', 'Sweet Apple Acres Farm',
    
    // Special Events
    'Grand Galloping Gala', 'Summer Sun Celebration', 'Winter Wrap Up', 'Nightmare Night', 'Hearth\'s Warming Eve',
    'Running of the Leaves', 'Best Young Flyer Competition', 'Iron Pony Competition'
  ];
  return words[Math.floor(Math.random() * words.length)];
}
function jumbleWord(word) {
  const arr = word.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

// --- Hard mode pools + difficulty wrappers ---
function pickTriviaQuestionHard() {
  const questions = [
    // Production and music (moderate-hard)
    { question: "Which composer handled underscore scoring for most FiM episodes?", choices: ["A) Daniel Ingram","B) William Anderson","C) Steffan Andrews","D) Kristopher Gee"], answer: 'B' },
    { question: "Who composed 'Luna's Future' in 'A Hearth's Warming Tail'?", choices: ["A) Daniel Ingram","B) William Anderson","C) Steffan Andrews","D) Caleb Chan"], answer: 'A' },

    // Foreshadowing and myth arc (hard)
    { question: "Which Season 4 episode first visibly shows the Rainbow Power key glow hint?", choices: ["A) Rarity Takes Manehattan","B) Pinkie Pride","C) Rainbow Falls","D) Filli Vanilli"], answer: 'A' },
    { question: "Which object ultimately unlocks the Rainbow Power infusion?", choices: ["A) Chest of Harmony Keys","B) Crystal Heart","C) Alicorn Amulet","D) Bewitching Bell"], answer: 'A' },

    // Pillars and Stygian (hard)
    { question: "Who originally discovered Stygian's motives weren't malicious in 'Shadow Play'?", choices: ["A) Twilight","B) Star Swirl","C) Starlight","D) Sunburst"], answer: 'C' },
    { question: "Which Pillar is associated with the artifact 'Blindfold of Justice' in extended lore?", choices: ["A) Somnambula","B) Rockhoof","C) Flash Magnus","D) Mistmane"], answer: 'A' },
    { question: "What was the prime misunderstanding that led to Stygian becoming the Pony of Shadows?", choices: ["A) Artifact theft for power","B) Betrayal by Starswirl","C) A miscast time spell","D) Tree of Harmony influence"], answer: 'A' },

    // Time and canon structure (hard)
    { question: "Which S5 episode quietly retcons the timeline via the time travel spell?", choices: ["A) The Cutie Re-Mark","B) Amending Fences","C) Slice of Life","D) Party Pooped"], answer: 'A' },
    { question: "Which episode reveals Starswirl's time spell earlier in canon?", choices: ["A) It's About Time","B) Princess Twilight Sparkle","C) The Cutie Re-Mark","D) Shadow Play"], answer: 'A' },

    // Fashion and Canterlot (moderate-hard)
    { question: "Whose family estate produced the dress Rarity tailored in 'Canterlot Boutique'?", choices: ["A) Prim Hemline","B) Sassy Saddles","C) Fancy Pants","D) Jet Set & Upper Crust"], answer: 'C' },
    { question: "Which Canterlot socialites snubbed Rarity in S2 before warming up later?", choices: ["A) Jet Set & Upper Crust","B) Fancy Pants & Fleur","C) Hoity Toity & Photo Finish","D) Prim Hemline & Sassy Saddles"], answer: 'A' },

    // Quotes and running gags (moderate)
    { question: "Which character canonically coins 'Twenty percent cooler' first?", choices: ["A) Rainbow Dash","B) Rarity","C) Soarin","D) Spitfire"], answer: 'A' },
    { question: "Which background pony became a mail carrier meme acknowledged on-screen?", choices: ["A) Bon Bon","B) Derpy Hooves","C) Lyra","D) Vinyl Scratch"], answer: 'B' },

    // Geography and artifacts (hard)
    { question: "What is Sunburst's canonical hometown?", choices: ["A) Sire's Hollow","B) Canterlot","C) Ponyville","D) Fillydelphia"], answer: 'A' },
    { question: "Which artifact temporarily suppresses horn magic in canon?", choices: ["A) Alicorn Amulet","B) Magic Disruptor Ring","C) Bewitching Bell","D) Time Tuner"], answer: 'B' },
    { question: "Which ancient artifact absorbed multiple magics in S9 before being shattered?", choices: ["A) Alicorn Amulet","B) Bewitching Bell","C) Idol of Boreas","D) Tome of Harmony"], answer: 'B' },

    // Lore references and books (hard)
    { question: "Which episode shows the first mention of 'Journal of the Two Sisters' on-screen?", choices: ["A) Castle Mane-ia","B) Princess Twilight Sparkle","C) Twilight's Kingdom","D) Daring Don't"], answer: 'A' },
    { question: "Which book directly ties into the Pillars' backstory?", choices: ["A) Journal of the Two Sisters","B) Daring Do and the Ring of Destiny","C) The Mare in the Moon","D) Clover's Notes"], answer: 'A' },

    // Wonderbolts (moderate-hard)
    { question: "Which Wonderbolt is commonly shown as the squad's tactical coordinator?", choices: ["A) Spitfire","B) Fleetfoot","C) Soarin","D) High Winds"], answer: 'A' },
    { question: "Which Wonderbolt historically trained Rainbow Dash in 'Wonderbolts Academy'?", choices: ["A) Spitfire","B) Blaze","C) Lightning Dust","D) Fleetfoot"], answer: 'A' },

    // Tree/Treehouse of Harmony (hard)
    { question: "What location did the Treehouse of Harmony grow near?", choices: ["A) The Everfree Castle Ruins","B) Ghastly Gorge","C) School of Friendship","D) Ponyville Lake"], answer: 'C' },
    { question: "Which six students catalyzed the Treehouse of Harmony's manifestation?", choices: ["A) The Cutie Mark Crusaders","B) The Young Six","C) The Pillars","D) The Mane Six"], answer: 'B' },

    // Characters and arcs (moderate-hard)
    { question: "Which episode gives Moondancer her reconciliation arc?", choices: ["A) Amending Fences","B) Castle Sweet Castle","C) Testing Testing 1, 2, 3","D) Do Princesses Dream of Magic Sheep"], answer: 'A' },
    { question: "Which villain trio is turned to stone in the finale?", choices: ["A) Chrysalis, Sombra, Tirek","B) Cozy Glow, Grogar, Tirek","C) Chrysalis, Cozy Glow, Tirek","D) Chrysalis, Discord, Sombra"], answer: 'C' },

    // Deep-cut details (hard)
    { question: "What item does Pinkie present to Cheese Sandwich in 'The Last Laugh' as a memento?", choices: ["A) Rubber chicken","B) Party planner badge","C) Joy buzzer","D) Cupcake pin"], answer: 'B' },
    { question: "Which changeling first challenges Thorax's leadership post-reformation?", choices: ["A) Pharynx","B) Ocellus","C) Caterina","D) Elytra"], answer: 'A' }
  ];
  return questions[Math.floor(Math.random() * questions.length)];
}
function pickJumbleWordHard() {
  const words = [
    'Hollow Shades', 'Our Town', "Sire's Hollow", 'Foal Mountain', 'Ghastly Gorge', 'Winsome Falls',
    'Treehouse of Harmony', 'Crystal Heart', 'Mirror Pool', 'Canterlot Archives', 'Star Swirl the Bearded Wing',
    'A.K. Yearling', 'Cheese Sandwich', 'Cranky Doodle Donkey', 'Princess Amore', 'Mistmane', 'Mage Meadowbrook',
    'Somnambula', 'Flash Magnus', 'Rockhoof', 'Stygian', 'Coco Pommel', 'Sassy Saddles', 'Fancy Pants',
    'The Last Laugh', 'Shadow Play', 'A Canterlot Wedding', 'The Cutie Re Mark', 'Magic Duel', 'Amending Fences',
    'Do Princesses Dream of Magic Sheep', 'Slice of Life', 'Luna Eclipsed', 'Make New Friends but Keep Discord',
    'Alicorn Amulet', 'Rainbow Power', 'Elements of Harmony', 'Pony of Shadows', 'Crystal Empire',
    'Mount Aris', 'Seaquestria', 'Yakyakistan', 'Griffonstone', 'Changeling Hive', 'Appleoosa'
  ];
  return words[Math.floor(Math.random() * words.length)];
}
function pickTriviaQuestionByDifficulty(mode) {
  return (mode === 'hard') ? pickTriviaQuestionHard() : pickTriviaQuestion();
}
function pickJumbleWordByDifficulty(mode) {
  return (mode === 'hard') ? pickJumbleWordHard() : pickJumbleWord();
}

// --- Minigame win handling ---
async function recordWin(guild, userId, gameKey) {
  const u = ensureUser(guild.id, userId);
  const prevTotal = u.wins?.total || 0;
  if (!u.wins) u.wins = { total: 0, snack: 0, cider: 0, trivia: 0, jumble: 0, heist: 0 };
  if (!(gameKey in u.wins)) u.wins[gameKey] = 0;
  u.wins[gameKey] += 1;
  u.wins.total += 1;
  saveDb();
  try {
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
    await applyWinnerRewards(member, prevTotal, u.wins.total);
  } catch (e) {
    console.log('recordWin error:', e?.message || e);
  }
}
function serveEmbed(item, targetUserMention) {
  return new EmbedBuilder()
    .setColor(item.color)
    .setTitle('Glimmer Cafe')
    .setDescription(`${item.emoji} ${item.text.replace('{user}', targetUserMention)}`);
}
function ordinal(n) { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// --- Ready: presence + register slash commands ---
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  c.user.setPresence({
    activities: [{ name: 'brewing at Glimmer Cafe ☕', type: ActivityType.Playing }],
    status: 'online',
  });

  // Kick off birthday checker and run daily at first ready of the day
  try { await checkBirthdaysDaily(c); } catch (_) {}
  setInterval(() => { checkBirthdaysDaily(c); }, 60 * 60 * 1000);

  const rest = new REST({ version: '10' }).setToken(token);
  const appId = c.user.id;

  const items = menuItems();
  const commands = [];

  // Food/drink commands (24 separate slash commands)
  for (const key of Object.keys(items)) {
    commands.push(
      new SlashCommandBuilder()
        .setName(key)
        .setDescription(`Serve a ${items[key].label}`)
        .addUserOption(o => o.setName('to').setDescription('Serve to someone else'))
    );
  }

  // Menu + order
  commands.push(
    new SlashCommandBuilder().setName('menu').setDescription('Show the Glimmer Cafe menu'),
    new SlashCommandBuilder().setName('order').setDescription('Open the Glimmer Cafe ordering menu')
  );

  // Minigames command (/game ...)
  const gameCmd = new SlashCommandBuilder().setName('game').setDescription('Minigames in Glimmer Cafe');
  gameCmd.addSubcommand(sc => 
    sc.setName('help').setDescription('Show minigame help')
  );
  gameCmd.addSubcommand(sc => 
    sc.setName('snack').setDescription('Start "Who\'s Snack Is It Anyway?" in this channel')
  );
  gameCmd.addSubcommand(sc => 
    sc.setName('cider')
      .setDescription('Start Cider Press Showdown vs a user')
      .addUserOption(o => 
        o.setName('opponent')
         .setDescription('Who to duel')
         .setRequired(true)
      )
  );
  // Placeholders for future games
  gameCmd.addSubcommand(sc => sc.setName('trivia').setDescription('Start Friendship Quiz (MLP Trivia)'));
  gameCmd.addSubcommand(sc => sc.setName('jumble').setDescription('Start Cutie Mark Jumble'));
  gameCmd.addSubcommand(sc => sc.setName('heist').setDescription('Start Cookie Caper (team heist)'));
  commands.push(gameCmd);

  // Admin level management (no XP leveling; manual levels only)
  const levelCmd = new SlashCommandBuilder().setName('level').setDescription('Admin: manage user levels (no XP system)');
  levelCmd.addSubcommand(sc =>
    sc.setName('show').setDescription('Show a user\'s level')
      .addUserOption(o => o.setName('user').setDescription('Whose level?'))
  );
  levelCmd.addSubcommand(sc =>
    sc.setName('set').setDescription('Admin: set a user\'s level')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('level').setDescription('New level').setRequired(true).setMinValue(0))
  );
  levelCmd.addSubcommand(sc =>
    sc.setName('add').setDescription('Admin: add (or subtract) a user\'s level')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('delta').setDescription('Amount to add (negative allowed)').setRequired(true).setMinValue(-200).setMaxValue(200))
  );
  commands.push(levelCmd);

  // Daily with item choice (+ streaks)
  const dailyCmd = new SlashCommandBuilder().setName('daily').setDescription('Claim your daily and advance your streak');
  for (const [key, it] of Object.entries(items)) {
    dailyCmd.addStringOption(o =>
      o.setName('item').setDescription('What are you having today?')
       .addChoices({ name: it.label, value: key })
    );
    break; // add once; choices added below (see fix)
  }
  // NOTE: Due to builder limitations, we add choices differently:
  // rebuild the option once with up to 25 choices
  const allChoices = Object.entries(items).map(([key, it]) => ({ name: it.label, value: key })).slice(0, 25);
  dailyCmd.options = []; // clear
  dailyCmd.addStringOption(o => {
    o.setName('item').setDescription('What are you having today? (sets/changes your streak item)');
    o.addChoices(...allChoices);
    return o;
  });
  commands.push(dailyCmd);

  // Streak admin + viewer
  const streakCmd = new SlashCommandBuilder().setName('streak').setDescription('View or manage streaks');
  streakCmd.addSubcommand(sc =>
    sc.setName('show').setDescription('Show a user\'s streak')
      .addUserOption(o => o.setName('user').setDescription('Whose streak?'))
  );
  streakCmd.addSubcommand(sc =>
    sc.setName('set').setDescription('Admin: set a user\'s streak count and optional item')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('count').setDescription('Streak count').setRequired(true).setMinValue(0))
      .addStringOption(o => {
        o.setName('item').setDescription('Set/override their item');
        for (const [key, it] of Object.entries(items)) o.addChoices({ name: it.label, value: key });
        return o;
      })
  );
  streakCmd.addSubcommand(sc =>
    sc.setName('add').setDescription('Admin: add (or subtract) from a user\'s streak')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('delta').setDescription('Amount to add (negative allowed)').setRequired(true).setMinValue(-365).setMaxValue(365))
  );
  streakCmd.addSubcommand(sc =>
    sc.setName('reset').setDescription('Admin: reset a user\'s streak')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
  );
  commands.push(streakCmd);

  // Points system
  const pointsCmd = new SlashCommandBuilder().setName('points').setDescription('View points and leaderboards');
  pointsCmd.addSubcommand(sc =>
    sc.setName('show').setDescription('Show a user\'s points and highest role')
      .addUserOption(o => o.setName('user').setDescription('Whose points?'))
  );
  pointsCmd.addSubcommand(sc =>
    sc.setName('leaderboard').setDescription('Show leaderboard for a game')
      .addStringOption(o => {
        o.setName('game').setDescription('Which game?').setRequired(true);
        o.addChoices(
          { name: 'All Games (Total)', value: 'total' },
          { name: 'Snack Game', value: 'snack' },
          { name: 'Cider Press', value: 'cider' },
          { name: 'Trivia Quiz', value: 'trivia' },
          { name: 'Word Jumble', value: 'jumble' },
          { name: 'Cookie Heist', value: 'heist' }
        );
        return o;
      })
  );
  commands.push(pointsCmd);

  // AI Chat commands
  const chatCmd = new SlashCommandBuilder().setName('chat').setDescription('Talk with Glimmer AI');
  chatCmd.addStringOption(o => 
    o.setName('message').setDescription('Your message to Glimmer').setRequired(true).setMaxLength(1000)
  );
  commands.push(chatCmd);

  const clearMemoryCmd = new SlashCommandBuilder().setName('clearmemory').setDescription('Clear your conversation memory with Glimmer');
  commands.push(clearMemoryCmd);

  // Birthday command
  const birthdayCmd = new SlashCommandBuilder().setName('birthday').setDescription('Register or view your birthday');
  birthdayCmd.addSubcommand(sc =>
    sc.setName('set').setDescription('Set your birthday (MM-DD)')
      .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31))
  );
  birthdayCmd.addSubcommand(sc => sc.setName('show').setDescription('Show your saved birthday'));
  birthdayCmd.addSubcommand(sc => sc.setName('remove').setDescription('Remove your saved birthday'));
  commands.push(birthdayCmd);

  try {
    const route = guildId ? Routes.applicationGuildCommands(appId, guildId) : Routes.applicationCommands(appId);
    await rest.put(route, { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// --- Leveling: slower XP per message with cooldown, role rewards, level-up posts in #levels ---
const lastAward = new Map(); // unused (kept to avoid breaking state)
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (guildId && msg.guild.id !== guildId) return;

  // Arcane level-up listener (in #levels channel)
  if (msg.channel.id === levelsChannelId && msg.author.bot && msg.author.id !== client.user.id) {
    // Look for Arcane level-up messages (common patterns)
    const levelMatch = msg.content.match(/(?:level|Level)\s*(\d+)/i);
    if (levelMatch) {
      const level = parseInt(levelMatch[1], 10);
      const userMention = msg.mentions.users.first();
      if (userMention) {
        try {
          const member = msg.guild.members.cache.get(userMention.id) || await msg.guild.members.fetch(userMention.id);
          const u = ensureUser(msg.guild.id, userMention.id);
          const prevLevel = u.level || 0;
          u.level = level;
          saveDb();
          await applyLevelRewards(member, prevLevel, level);
          console.log(`Arcane level-up detected: ${userMention.username} reached level ${level}`);
        } catch (e) {
          console.error('Arcane level-up handling error:', e);
        }
      }
    }
  }

  // AI Chat on mention
  if (msg.mentions.has(client.user) && !msg.content.startsWith('!') && !msg.content.startsWith('/')) {
    const message = msg.content.replace(/<@!?\d+>/g, '').trim();
    if (message) {
      msg.channel.sendTyping().catch(() => {});
      try {
        const response = await generateAIResponse(msg.author.id, message, msg.guild.id);
        await msg.channel.send(response).catch(() => {});
      } catch (error) {
        console.error('Mention chat error:', error);
        await msg.channel.send("Sorry, I'm having trouble thinking right now. Maybe try again later! ☕").catch(() => {});
      }
    }
  }

  // Keyword fun replies (case-insensitive)
  try {
    const lower = msg.content.toLowerCase();
    // "artie" summon
    if (lower.includes('artie')) {
      msg.channel.send('The Artie has been summoned!').catch(() => {});
    }

    // React to any text containing "boop" (words, emojis, anywhere in the message)
    if (/boop/i.test(msg.content)) {
      const boopEmoji = msg.guild.emojis?.cache?.find(e => e.name?.toLowerCase() === 'glimboop');
      if (boopEmoji) msg.react(boopEmoji).catch(() => {});
    }

    // React to any text containing "hug" (words, emojis, anywhere in the message)
    if (/hug/i.test(msg.content)) {
      const hugEmoji = msg.guild.emojis?.cache?.find(e => e.name?.toLowerCase() === 'hugs');
      if (hugEmoji) msg.react(hugEmoji).catch(() => {});
    }
    if (lower.includes('chaos')) {
      msg.channel.send('Nah, just muffins. All hail Derpy Hooves!').catch(() => {});
    }
    if (lower.includes('twinkie winkie')) {
      msg.channel.send("Twinkie winkie my cutie, you're the best! :purple_heart:").catch(() => {});
    }
  } catch (_) {}

  // --- Prefix commands starting with '!' ---
  const prefix = '!';
  if (!msg.content.startsWith(prefix)) return;

  const args = msg.content.slice(prefix.length).trim().split(/\s+/);
  const commandName = (args.shift() || '').toLowerCase();
  const items = menuItems();

  // Moderation commands (admin only)
  if (['warn','mute','unmute','ban'].includes(commandName)) {
    const isAdmin = msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin) {
      return msg.channel.send('Administrator only.').catch(() => {});
    }

    const target = msg.mentions.members?.first() || (args[0] ? await msg.guild.members.fetch(args[0].replace(/[^0-9]/g,'')).catch(() => null) : null);
    if (!target) {
      const usage = {
        warn: 'Usage: !warn @user <reason>',
        mute: 'Usage: !mute @user <duration> <reason> (duration: 10m, 2h, 1d)',
        unmute: 'Usage: !unmute @user',
        ban:  'Usage: !ban @user <reason>'
      };
      return msg.channel.send(usage[commandName]).catch(() => {});
    }

    if (!target.bannable && commandName === 'ban') {
      return msg.channel.send('I lack permission to ban that user.').catch(() => {});
    }

    if (!target.moderatable && (commandName === 'warn' || commandName === 'mute' || commandName === 'unmute')) {
      // Fallback: still allow warn (message only) even if not moderatable
      if (commandName !== 'warn') return msg.channel.send('I cannot moderate that user.').catch(() => {});
    }

    if (commandName === 'warn') {
      const reason = args.slice(1).join(' ').trim() || 'No reason provided';
      const rulesChannel = msg.guild.channels.cache.find(c => c.name.toLowerCase() === 'rules');
      const rulesMention = rulesChannel ? `<#${rulesChannel.id}>` : '#rules';
      const lines = [
        `${target} has been warned`,
        `Reason: ${reason}`,
        `Please head over to ${rulesMention} and see if you forgot anything`
      ];
      // Try DM as well, ignore failure
      target.user?.send(`You were warned in ${msg.guild.name} for: ${reason}`).catch(() => {});
      return msg.channel.send(lines.join('\n')).catch(() => {});
    }

    if (commandName === 'mute') {
      const durationArg = args[1];
      const ms = parseDurationToMs(durationArg);
      if (!ms) {
        return msg.channel.send('Please provide a valid duration (e.g., 10m, 2h, 1d).').catch(() => {});
      }
      const reason = args.slice(2).join(' ').trim() || 'No reason provided';
      let mutedRole = msg.guild.roles.cache.find(r => r.name === 'Muted')
        || await msg.guild.roles.fetch().then(col => col.find(r => r.name === 'Muted')).catch(() => null);
      if (!mutedRole) {
        return msg.channel.send('Muted role not found. Please create a role named "Muted".').catch(() => {});
      }
      if (!target.roles.cache.has(mutedRole.id)) {
        // Store current roles before muting
        await storeRolesForMute(target);
        // Remove all roles except @everyone and add Muted role
        const rolesToRemove = target.roles.cache.filter(role => role.id !== target.guild.id);
        await target.roles.set([mutedRole.id], `Muted for ${durationArg}: ${reason}`).catch(() => {});
      }
      const rulesChannel = msg.guild.channels.cache.find(c => c.name.toLowerCase() === 'rules');
      const rulesMention = rulesChannel ? `<#${rulesChannel.id}>` : '#rules';
      const lines = [
        `${target} has been muted for ${durationArg}`,
        `Reason: ${reason}`,
        `Please head over to ${rulesMention} and see if you forgot anything`
      ];
      msg.channel.send(lines.join('\n')).catch(() => {});
      // Schedule unmute
      setTimeout(async () => {
        try {
          const fresh = await msg.guild.members.fetch(target.id).catch(() => null);
          if (fresh && fresh.roles.cache.has(mutedRole.id)) {
            await fresh.roles.remove(mutedRole, 'Mute duration ended').catch(() => {});
            // Restore all previously stored roles
            await restoreRolesAfterMute(fresh);
            const endMsg = `${fresh} is now unmuted (mute ended). All roles have been restored.`;
            msg.channel.send(endMsg).catch(() => {});
          }
        } catch (_) {}
      }, ms);
      return;
    }

    if (commandName === 'unmute') {
      let mutedRole = msg.guild.roles.cache.find(r => r.name === 'Muted')
        || await msg.guild.roles.fetch().then(col => col.find(r => r.name === 'Muted')).catch(() => null);
      if (!mutedRole) {
        return msg.channel.send('Muted role not found. Please create a role named "Muted".').catch(() => {});
      }
      if (!target.roles.cache.has(mutedRole.id)) {
        return msg.channel.send('This user is not currently muted.').catch(() => {});
      }
      await target.roles.remove(mutedRole, 'Manually unmuted by admin').catch(() => {});
      // Restore all previously stored roles
      await restoreRolesAfterMute(target);
      return msg.channel.send(`${target} has been unmuted and all roles have been restored.`).catch(() => {});
    }

    if (commandName === 'ban') {
      const reason = args.slice(1).join(' ').trim() || 'No reason provided';
      try {
        await target.ban({ reason });
      } catch (e) {
        return msg.channel.send('Failed to ban the user. Check my permissions/role position.').catch(() => {});
      }
      const lines = [
        `${target.user?.tag || target.user?.id || 'User'} has been banned`,
        'I really don\'t want to do this, but you\'re taking it too far.',
        `Reason: ${reason}`
      ];
      return msg.channel.send(lines.join('\n')).catch(() => {});
    }
  }

  // Help (non-admin commands only)
  if (commandName === 'help') {
    const itemNames = Object.keys(items).sort().join(', ');
    const lines = [
      '**Glimmer Cafe Commands**',
      `!menu — Show the menu and order selector`,
      `!order — Same as !menu`,
      `!level show [@user] — Show a level (admin set/add available)`,
      `!daily item:<key> — Claim daily and set your streak item`,
      `!streak show [@user] — View a streak (admin subcommands hidden)`,
      `!points show [@user] — View points and highest role`,
      `!points leaderboard <game> — View leaderboard`,
      `!game help — Minigame list`,
      `!game snack — Guess the pony from snack hints`,
      `!game cider @user — 10s button duel`,
      `!game trivia — MLP trivia quiz`,
      `!game jumble — Word unscrambling`,
      `!game heist — Team cookie heist`,
      `!unmute @user — Admin: unmute user and restore roles`,
      `!chat <message> — Talk with Glimmer AI`,
      `!clearmemory — Clear your AI conversation memory`,
      `!birthday set MM-DD — Register your birthday`,
      `!birthday show — View your saved birthday`,
      `Food & drinks: ${itemNames}`
    ];
    return msg.channel.send(lines.join('\n')).catch(() => {});
  }

  // Birthday (prefix)
  if (commandName === 'birthday') {
    const sub = (args.shift() || 'show').toLowerCase();
    const u = ensureUser(msg.guild.id, msg.author.id);
    if (sub === 'set') {
      const mmdd = (args.shift() || '').trim();
      const m = parseInt(mmdd.split('-')[0], 10);
      const d = parseInt((mmdd.split('-')[1] || ''), 10);
      if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
        return msg.channel.send('Usage: !birthday set MM-DD').catch(() => {});
      }
      u.birthday.month = m; u.birthday.day = d; saveDb();
      return msg.channel.send(`Saved your birthday as ${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}.`).catch(() => {});
    }
    if (sub === 'show') {
      if (u.birthday?.month && u.birthday?.day) {
        return msg.channel.send(`Your birthday on file is ${String(u.birthday.month).padStart(2,'0')}-${String(u.birthday.day).padStart(2,'0')}.`).catch(() => {});
      }
      return msg.channel.send('You have not set a birthday. Use !birthday set MM-DD').catch(() => {});
    }
    if (sub === 'remove') {
      u.birthday = { month: null, day: null, lastYearCelebrated: null }; saveDb();
      return msg.channel.send('Removed your saved birthday.').catch(() => {});
    }
  }

  // Prefix minigames
  if (commandName === 'game') {
    const sub = (args.shift() || 'help').toLowerCase();
    if (sub === 'help') {
      const lines = [
        '**Minigames**',
        '!game snack — Guess the pony from snack hints (+10 points)',
        '!game cider @user — Apple pressing duel (+15 points)',
        '!game trivia — Friendship Quiz with 50+ questions (+12 points)',
        '!game jumble — Cutie Mark Jumble with speed bonus (+8 points)',
        '!game heist — Team Cookie Caper heist (+20 points)',
      ];
      return msg.channel.send(lines.join('\n')).catch(() => {});
    }
    // Call with: await handleSnack(msg);
    async function handleSnack(msg) {
      if (sub !== 'snack') return;

      const channelId = msg.channel.id;
      global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };

      if (global.__glimmerGames.snack[channelId]) {
        await msg.channel.send('A snack round is already running here.').catch(() => {});
        return;
      }

      const rounds = [
        // Mane 6
        { answer: 'Pinkie Pie',        hints: ['Cupcakes', 'Party cannon', 'Sugarcube Corner'] },
        { answer: 'Applejack',         hints: ['Zap apples', 'Sweet Apple Acres', 'Honesty'] },
        { answer: 'Rarity',            hints: ['Gems', 'Carousel Boutique', 'Fashion'] },
        { answer: 'Rainbow Dash',      hints: ['20% cooler', 'Wonderbolts', 'Sonic Rainboom'] },
        { answer: 'Fluttershy',        hints: ['Animals', 'Stare', 'Kindness'] },
        { answer: 'Twilight Sparkle',  hints: ['Books', 'Magic', 'Friendship lessons'] },

        // Princesses and rulers
        { answer: 'Princess Celestia', hints: ['Sun', 'Cake', 'Day Court'] },
        { answer: 'Princess Luna',     hints: ['Moon', 'Dreams', 'Royal Canterlot Voice'] },
        { answer: 'Princess Cadance',  hints: ['Love magic', 'Crystal Empire', 'Shining Armor'] },
        { answer: 'Flurry Heart',      hints: ['Alicorn foal', 'Crystal Empire', 'Big sneeze'] },

        // Cutie Mark Crusaders
        { answer: 'Apple Bloom',       hints: ['Bow', 'Cutie Mark Crusaders', 'Potions'] },
        { answer: 'Sweetie Belle',     hints: ['Singing', "Rarity's sister", 'CMCs'] },
        { answer: 'Scootaloo',         hints: ['Scooter', 'Wings', 'Rainbow Dash fan'] },

        // Secondary/recurring
        { answer: 'Starlight Glimmer', hints: ['Village', 'Cutie mark equality', 'Guidance counselor'] },
        { answer: 'Sunset Shimmer',    hints: ['Mirror portal', 'Empathy', 'Former student'] },
        { answer: 'Trixie',            hints: ['Great and Powerful', 'Stage magician', 'Boasts'] },
        { answer: 'Spike',             hints: ['Dragon', 'Scrolls', 'Gems'] },
        { answer: 'Discord',           hints: ['Chaos magic', 'Q-like', 'Chocolate rain'] },
        { answer: 'Zecora',            hints: ['Everfree Forest', 'Rhymes', 'Potions'] },
        { answer: 'Big McIntosh',      hints: ['Eeyup', 'Apple family', 'Strong'] },
        { answer: 'Granny Smith',      hints: ['Apple family', 'Fritter', 'Old Pony'] },
        { answer: 'Shining Armor',     hints: ['Royal Guard', 'BBBFF', 'Shield spell'] },
        { answer: 'Cheese Sandwich',   hints: ['Accordion', 'Party pony', 'Weird Al'] },

        // School of Friendship / students
        { answer: 'Gallus',            hints: ['Griffon', 'Blue feathers', 'School of Friendship'] },
        { answer: 'Smolder',           hints: ['Dragon', 'Snarky', 'School of Friendship'] },
        { answer: 'Ocellus',           hints: ['Changeling', 'Shy', 'Shapes'] },
        { answer: 'Silverstream',      hints: ['Hippogriff', 'Seapony', 'Excitable'] },
        { answer: 'Yona',              hints: ['Yak', 'Smash', 'Best at friendship!'] },
        { answer: 'Sandbar',           hints: ['Earth pony', 'Laid-back', 'School of Friendship'] },

        // Background favorites
        { answer: 'Derpy Hooves',      hints: ['Muffins', 'Mail', 'Wall-eyed'] },
        { answer: 'Lyra Heartstrings', hints: ['Harp', 'Humans?', 'Mint unicorn'] },
        { answer: 'Bon Bon',           hints: ['Sweets', 'Secret agent?', "Lyra's friend"] },
        { answer: 'Octavia Melody',    hints: ['Cello', 'Classical', 'Gray earth pony'] },
        { answer: 'DJ Pon-3',          hints: ['Vinyl Scratch', 'Wubs', 'Headphones'] },
        { answer: 'Doctor Hooves',     hints: ['Hourglass', 'Timey-wimey', 'Science'] },
        { answer: 'Berry Punch',       hints: ['Grapes', 'Ponyville', 'Juice stand'] },

        // Villains / reformed
        { answer: 'Queen Chrysalis',   hints: ['Changelings', 'Love drain', 'Hive'] },
        { answer: 'King Sombra',       hints: ['Crystal Empire', 'Shadows', 'Horns of black crystal'] },
        { answer: 'Lord Tirek',        hints: ['Magic drain', 'Centaur', 'Brothers?'] },
        { answer: 'Cozy Glow',         hints: ['Filly', 'Schemer', 'Friendship School'] },

        // More friends
        { answer: 'Maud Pie',          hints: ['Rocks', 'Monotone', 'Boulder'] },
        { answer: 'Marble Pie',        hints: ['Shy', 'Pie family', 'Timid'] },
        { answer: 'Limestone Pie',     hints: ['Quarry', 'Grumpy', 'Big sister energy'] },
        { answer: 'Tempest Shadow',    hints: ['Broken horn', 'Storm King', 'Kicks'] },
        { answer: 'Thorax',            hints: ['Reformed changeling', 'King', 'Friendship snacks?'] },
        { answer: 'Pharynx',           hints: ['Changeling', 'Guard', 'Brother of Thorax'] },
        { answer: 'Coloratura',        hints: ['Pop star', 'Rara', 'Countess'] },
        { answer: 'Sapphire Shores',   hints: ['Pop diva', 'Sequins', 'Stage'] },
        { answer: 'Spitfire',          hints: ['Wonderbolts', 'Captain', 'Goggles'] },
        { answer: 'Soarin',            hints: ['Wonderbolts', 'Pie lover', 'Blue mane'] },
        { answer: 'Daring Do',         hints: ['Adventurer', 'Author', 'A.K. Yearling'] }
      ];

      const pick = rounds[Math.floor(Math.random() * rounds.length)];
      global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };
      global.__glimmerGames.snack = global.__glimmerGames.snack || {};
      global.__glimmerGames.snack[channelId] = { answer: pick.answer.toLowerCase(), over: false };

      const hintText = pick.hints.map((h, i) => `Hint ${i + 1}: ${h}`).join('\n');
      await msg.channel
        .send(`Who's Snack Is It Anyway?\n${hintText}\nReply the pony name in chat`)
        .catch(() => {});

      const collector = msg.channel.createMessageCollector({
        filter: m => !m.author.bot && m.channelId === channelId,
        time: 30_000
      });

      collector.on('collect', async (m) => {
        const guess = m.content.trim().toLowerCase();
        const state = global.__glimmerGames.snack[channelId];
        if (!state || state.over) return;

        if (guess.includes(state.answer)) {
          state.over = true;
          collector.stop('win');

          const points = await awardPoints(msg.guild, m.author.id, 'snack');
          await recordWin(msg.guild, m.author.id, 'snack');

          await msg.channel
            .send(`Correct! ${m.author} guessed ${pick.answer}! (+${points} points)`)
            .catch(() => {});
        }
      });

      collector.on('end', () => {
        delete global.__glimmerGames.snack[channelId];
      });
    }
    if (sub === 'trivia') {
      const q = pickTriviaQuestion();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`trivia:A`).setLabel(q.choices[0]).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`trivia:B`).setLabel(q.choices[1]).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`trivia:C`).setLabel(q.choices[2]).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`trivia:D`).setLabel(q.choices[3]).setStyle(ButtonStyle.Primary),
      );
      global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };
      global.__glimmerGames.trivia[msg.channel.id] = { correct: q.answer, askedAt: Date.now(), over: false };
      await msg.channel.send({ content: `Friendship Quiz:\n${q.question}`, components: [row] }).catch(() => {});
      setTimeout(() => {
        const state = global.__glimmerGames.trivia[msg.channel.id];
        if (state && !state.over) {
          msg.channel.send(`Time's up! The correct answer was ${q.answer}.`).catch(() => {});
          delete global.__glimmerGames.trivia[msg.channel.id];
        }
      }, 20_000);
      return;
    }

    // Call this from your command router: await handleJumble(msg);
    async function handleJumble(msg) {
      if (sub !== 'jumble') return;

      global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };

      if (global.__glimmerGames.jumble[msg.channel.id]) {
        await msg.channel.send('A jumble round is already running here.').catch(() => {});
        return;
      }

      const word = pickJumbleWord();
      const jumbled = jumbleWord(word);

      // store normalized answer and timestamps for bonus
      global.__glimmerGames.jumble[msg.channel.id] = { answer: word.toLowerCase(), over: false, startedAt: Date.now() };

      await msg.channel
        .send(`Cutie Mark Jumble! Unscramble: **${jumbled}** (20s)
Tip: punctuation and spacing are ignored when guessing.`)
        .catch(() => {});

      const collector = msg.channel.createMessageCollector({
        filter: m => !m.author.bot && m.channelId === msg.channel.id,
        time: 20_000
      });

      // mid-round hint after half the time: reveal first letter
      const hintTimer = setTimeout(() => {
        try { msg.channel.send(`Hint: the answer starts with **${word[0]}**`).catch(() => {}); } catch (_) {}
      }, 10_000);

      const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

      collector.on('collect', async (m) => {
        const guess = normalize(m.content);
        const state = global.__glimmerGames.jumble[msg.channel.id];
        if (!state || state.over) return;

        if (guess === normalize(state.answer)) {
          state.over = true;
          collector.stop('win');
          clearTimeout(hintTimer);

          const elapsed = Date.now() - (state.startedAt || Date.now());
          // base points + fast bonus
          const base = await awardPoints(msg.guild, m.author.id, 'jumble');
          // awardPoints may already persist; give a fast bonus if under 6s
          let bonus = 0;
          if (elapsed < 6_000) {
            bonus = 5;
            const u = ensureUser(msg.guild.id, m.author.id);
            u.points = u.points || {}; u.points.jumble = (u.points.jumble || 0) + bonus; u.points.total = (u.points.total || 0) + bonus;
            saveDb();
          }
          await recordWin(msg.guild, m.author.id, 'jumble');

          await msg.channel
            .send(`Correct! ${m.author} unscrambled **${word}**! (+${base + bonus} points${bonus ? ` — including ${bonus}-point speed bonus` : ''})`)
            .catch(() => {});
        }
      });

      collector.on('end', () => {
        clearTimeout(hintTimer);
        delete global.__glimmerGames.jumble[msg.channel.id];
      });
    }

    // Call with: await handleHeist(msg);
    async function handleHeist(msg) {
      if (sub !== 'heist') return;

      global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };

      if (global.__glimmerGames.heist[msg.channel.id]) {
        await msg.channel.send('A heist is already forming here.').catch(() => {});
        return;
      }

      const joinId = `heist-join:${msg.channel.id}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(joinId).setLabel('Join Heist').setStyle(ButtonStyle.Success)
      );

      global.__glimmerGames.heist[msg.channel.id] = { members: new Set([msg.author.id]), over: false };

      await msg.channel
        .send({ content: 'Cookie Caper forming! Click to join (15s).', components: [row] })
        .catch(() => {});

      // Collect button presses elsewhere in your interactionCreate handler:
      // if (interaction.isButton() && interaction.customId === joinId) {
      //   const state = global.__glimmerGames.heist[interaction.channel.id];
      //   if (state && !state.over) state.members.add(interaction.user.id);
      //   await interaction.deferUpdate().catch(() => {});
      // }

      setTimeout(async () => {
        const state = global.__glimmerGames.heist[msg.channel.id];
        if (!state || state.over) return;

        state.over = true;
        const count = state.members.size;
        delete global.__glimmerGames.heist[msg.channel.id];

        if (count === 0) {
          await msg.channel.send('No one joined the heist.').catch(() => {});
          return;
        }

        // Enhanced heist mechanics with different outcomes
        const baseSuccessChance = Math.min(85, 25 + count * 12);
        const roll = Math.floor(Math.random() * 100) + 1;
        
        // Special bonus for certain team sizes
        let bonus = 0;
        if (count === 6) bonus = 10; // Perfect Mane 6 team
        else if (count === 3) bonus = 5; // Cutie Mark Crusaders team
        else if (count >= 8) bonus = 8; // Large team bonus
        
        const successChance = Math.min(95, baseSuccessChance + bonus);
        
        // Different outcomes based on roll
        if (roll <= successChance) {
          const members = Array.from(state.members);
          const points = await awardPoints(msg.guild, members[0], 'heist');
          await Promise.all(
            members.map(async uid => {
              await recordWin(msg.guild, uid, 'heist');
            })
          );

          // Different success messages based on performance
          let successMessage = '';
          if (roll <= 20) {
            successMessage = `🎉 **PERFECT HEIST!** ${count} friends executed the Cookie Caper flawlessly! (roll ${roll} ≤ ${successChance})`;
          } else if (roll <= 50) {
            successMessage = `🍪 **Great Success!** ${count} friends pulled off the Cookie Caper! (roll ${roll} ≤ ${successChance})`;
          } else {
            successMessage = `🍪 **Success!** ${count} friends managed the Cookie Caper! (roll ${roll} ≤ ${successChance})`;
          }
          
          if (bonus > 0) {
            successMessage += `\n✨ **Team Bonus:** +${bonus}% for ${count === 6 ? 'perfect Mane 6 team' : count === 3 ? 'Cutie Mark Crusaders team' : 'large team'}!`;
          }
          
          successMessage += `\n💰 Each member earned ${points} points!`;
          
          await msg.channel.send(successMessage).catch(() => {});
        } else {
          // Different failure messages
          let failureMessage = '';
          if (roll >= 95) {
            failureMessage = `💥 **Catastrophic Failure!** The Cookie Caper was completely foiled! (roll ${roll} > ${successChance})`;
          } else if (roll >= 85) {
            failureMessage = `😱 **Major Setback!** Discord's chaos ruined the Cookie Caper! (roll ${roll} > ${successChance})`;
          } else {
            failureMessage = `😔 **Foiled!** The Cookie Caper didn't go as planned. (roll ${roll} > ${successChance})`;
          }
          
          await msg.channel.send(failureMessage).catch(() => {});
        }
      }, 15_000);
    }
    // Call with: await handleCider(msg);
    async function handleCider(msg) {
      if (sub !== 'cider') return;
      const opponent = msg.mentions.members?.first() || (args[1] ? await msg.guild.members.fetch(args[1].replace(/[^0-9]/g,'')).catch(() => null) : null);
      if (!opponent || opponent.user?.bot || opponent.id === msg.author.id) {
        return msg.channel.send('Challenge someone with !game cider @user').catch(() => {});
      }
      const channelId = msg.channel.id;
      global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };
      if (global.__glimmerGames.cider[channelId]) {
        await msg.channel.send('A cider duel is already running here.').catch(() => {});
        return;
      }
      const challengerId = msg.author.id;
      const opponentId = opponent.id;
      global.__glimmerGames.cider[channelId] = { challengerId, opponentId, over: false };
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cider:${challengerId}:${opponentId}`).setLabel('Press!').setStyle(ButtonStyle.Primary).setEmoji('🍎')
        );
        await msg.channel.send({ content: `${opponent}, you have been challenged to a Cider Press duel by ${msg.author}! First to press wins! (10s)`, components: [row] }).catch(() => {});
        setTimeout(() => {
          const state = global.__glimmerGames.cider[channelId];
          if (state && !state.over) {
            msg.channel.send(`Time's up! No one pressed the cider in time.`).catch(() => {});
            delete global.__glimmerGames.cider[channelId];
          }
        }, 10_000);
      return;
    }
    await handleSnack(msg);
    await handleJumble(msg);
    await handleHeist(msg);
    await handleCider(msg);
    return;
  }

  // Food/drink commands
  if (items[commandName]) {
    const targetUser = msg.mentions.users.first() || msg.author;
    const embed = serveEmbed(items[commandName], `<@${targetUser.id}>`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`refill:${commandName}:${targetUser.id}`).setLabel('Refill').setStyle(ButtonStyle.Success)
    );
    return msg.channel.send({ embeds: [embed], components: [row] }).catch(() => {});
  }

  if (commandName === 'order' || commandName === 'menu') {
    const row = buildMenuRow(items);
    const embed = buildMenuEmbed(items);
    return msg.channel.send({ content: 'Welcome to Glimmer Cafe! What would you like?', embeds: [embed], components: [row] }).catch(() => {});
  }

  // Admin: manual level management (prefix)
  if (commandName === 'level') {
    const isAdmin = msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    const sub = (args.shift() || 'show').toLowerCase();
    if (sub === 'show') {
    const targetUser = msg.mentions.users.first() || msg.author;
      const u = ensureUser(msg.guild.id, targetUser.id);
    const embed = new EmbedBuilder()
      .setColor(0xFFC0CB)
        .setTitle(`${targetUser.username}'s Level`)
      .addFields(
          { name: 'Level', value: `${u.level}`, inline: true }
      );
    return msg.channel.send({ embeds: [embed] }).catch(() => {});
  }
    if (!isAdmin) return msg.channel.send('Administrator only.').catch(() => {});
    if (sub === 'set') {
      const target = msg.mentions.members?.first() || (args[0] ? await msg.guild.members.fetch(args[0].replace(/[^0-9]/g,'')).catch(() => null) : null);
      const levelArg = args.find(a => /^\d+$/.test(a));
      if (!target || !levelArg) return msg.channel.send('Usage: !level set @user <level>').catch(() => {});
      const u = ensureUser(msg.guild.id, target.id);
      const prev = u.level || 0;
      const next = Math.max(0, parseInt(levelArg, 10));
      u.level = next;
      saveDb();
      await applyLevelRewards(target, prev, next);
      if (levelsChannelId) {
        const ch = msg.guild.channels.cache.get(levelsChannelId) || await msg.guild.channels.fetch(levelsChannelId).catch(() => null);
        if (ch && next > prev) ch.send(`${target.displayName || target.user.username} has reached level ${next}!`).catch(() => {});
      }
      return msg.channel.send(`Set ${target.user.username}'s level to ${next}.`).catch(() => {});
    }
    if (sub === 'add') {
      const target = msg.mentions.members?.first() || (args[0] ? await msg.guild.members.fetch(args[0].replace(/[^0-9]/g,'')).catch(() => null) : null);
      const deltaArg = args.find(a => /^-?\d+$/.test(a));
      if (!target || !deltaArg) return msg.channel.send('Usage: !level add @user <delta>').catch(() => {});
      const u = ensureUser(msg.guild.id, target.id);
      const prev = u.level || 0;
      const next = Math.max(0, prev + parseInt(deltaArg, 10));
      u.level = next;
      saveDb();
      await applyLevelRewards(target, prev, next);
      if (levelsChannelId) {
        const ch = msg.guild.channels.cache.get(levelsChannelId) || await msg.guild.channels.fetch(levelsChannelId).catch(() => null);
        if (ch && next > prev) ch.send(`${target.displayName || target.user.username} has reached level ${next}!`).catch(() => {});
      }
      return msg.channel.send(`Adjusted ${target.user.username}'s level by ${next - prev}. New level: ${next}.`).catch(() => {});
    }
    return;
  }

  if (commandName === 'daily') {
    const kv = Object.fromEntries(args.map(a => {
      const [k, ...rest] = a.split(':');
      return [k.toLowerCase(), rest.join(':')];
    }));
    const chosen = kv.item; // key
    const u = ensureUser(msg.guild.id, msg.author.id);
    const now2 = Date.now();
    const today2 = dayIndexDaily(now2);

    if (u.lastDailyDay === today2) {
      const label = u.streakItem ? items[u.streakItem].label : 'your item';
      return msg.channel.send(`You already claimed your daily ${label} today. Streak: ${u.streakCount} day(s).`).catch(() => {});
    }

    if (chosen) u.streakItem = chosen;
    if (!u.streakItem) {
      return msg.channel.send('Pick your streak item with !daily item:<choice> (this sets what you come back for each day).').catch(() => {});
    }

    const prevStreak = u.streakCount || 0;
    if (u.lastDailyDay == null || today2 - u.lastDailyDay > 1) {
      u.streakCount = 1; // reset
    } else if (today2 - u.lastDailyDay === 1) {
      u.streakCount += 1; // continue
    } else {
      u.streakCount = Math.max(1, u.streakCount);
    }
    u.lastDailyDay = today2;
    u.lastDaily = now2;

    // Apply streak rewards if streak increased
    if (u.streakCount > prevStreak) {
      try {
        const member = msg.member || await msg.guild.members.fetch(msg.author.id);
        await applyStreakRewards(member, prevStreak, u.streakCount);
        await grantPlaceholderRole(member);
      } catch (e) {
        console.error('Streak reward error:', e);
      }
    }

    const it = items[u.streakItem];
    const text = `${it.emoji} Daily ${it.label} recorded! Streak: ${u.streakCount} day(s).`;
    await msg.channel.send(text).catch(() => {});

    if (levelsChannelId && (u.streakCount % 7 === 0)) {
      const ch = msg.guild.channels.cache.get(levelsChannelId)
        || await msg.guild.channels.fetch(levelsChannelId).catch(() => null);
      if (ch) {
        const member = msg.member || await msg.guild.members.fetch(msg.author.id);
        const name = member.displayName || member.user.username;
        ch.send(`${name} kept their ${it.label} streak for ${u.streakCount} days!`).catch(() => {});
      }
    }
    return;
  }

  if (commandName === 'streak') {
    const sub = (args.shift() || 'show').toLowerCase();
    const isAdmin = msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    const gId = msg.guild.id;

    if (sub === 'show') {
      const targetUser = msg.mentions.users.first() || msg.author;
      const u = ensureUser(gId, targetUser.id);
      const itemsMap = menuItems();
      const label = u.streakItem ? itemsMap[u.streakItem]?.label || 'Unknown' : 'None';
      const last = u.lastDaily ? new Date(u.lastDaily).toLocaleString() : 'Never';
      const embed = new EmbedBuilder()
        .setColor(0xFFC0CB)
        .setTitle(`${targetUser.username}'s Daily Streak`)
        .addFields(
          { name: 'Item', value: label, inline: true },
          { name: 'Streak', value: `${u.streakCount} day(s)`, inline: true },
          { name: 'Last Claimed', value: last }
        );
      return msg.channel.send({ embeds: [embed] }).catch(() => {});
    }

    if (!isAdmin) {
      return msg.channel.send('Administrator only.').catch(() => {});
    }

    if (sub === 'set') {
      const targetUser = msg.mentions.users.first();
      const countArg = args.find(a => /^\d+$/.test(a));
      const itemArg = (args.find(a => a.startsWith('item:')) || '').split(':').slice(1).join(':');
      if (!targetUser || !countArg) {
        return msg.channel.send('Usage: !streak set @user <count> [item:<key>]').catch(() => {});
      }
      const count = Math.max(0, parseInt(countArg, 10));
      const u = ensureUser(gId, targetUser.id);
      const prevStreak = u.streakCount || 0;
      u.streakCount = count;
      if (itemArg) u.streakItem = itemArg;
      saveDb();
      // Apply streak rewards if streak increased
      if (count > prevStreak) {
        try {
          const member = msg.guild.members.cache.get(targetUser.id) || await msg.guild.members.fetch(targetUser.id);
          await applyStreakRewards(member, prevStreak, count);
        } catch (e) {
          console.error('Streak reward error:', e);
        }
      }
      const itemsMap = menuItems();
      const label = u.streakItem ? itemsMap[u.streakItem]?.label || 'Unknown' : 'None';
      return msg.channel.send(`Set ${targetUser.username}'s streak to ${u.streakCount} (item: ${label}).`).catch(() => {});
    }

    if (sub === 'add') {
      const targetUser = msg.mentions.users.first();
      const deltaArg = args.find(a => /^-?\d+$/.test(a));
      if (!targetUser || !deltaArg) {
        return msg.channel.send('Usage: !streak add @user <delta>').catch(() => {});
      }
      const delta = parseInt(deltaArg, 10);
      const u = ensureUser(gId, targetUser.id);
      const prevStreak = u.streakCount || 0;
      u.streakCount = Math.max(0, prevStreak + delta);
      saveDb();
      // Apply streak rewards if streak increased
      if (u.streakCount > prevStreak) {
        try {
          const member = msg.guild.members.cache.get(targetUser.id) || await msg.guild.members.fetch(targetUser.id);
          await applyStreakRewards(member, prevStreak, u.streakCount);
        } catch (e) {
          console.error('Streak reward error:', e);
        }
      }
      return msg.channel.send(`Adjusted ${targetUser.username}'s streak by ${delta}. New streak: ${u.streakCount}.`).catch(() => {});
    }

    if (sub === 'reset') {
      const targetUser = msg.mentions.users.first();
      if (!targetUser) {
        return msg.channel.send('Usage: !streak reset @user').catch(() => {});
      }
      const u = ensureUser(gId, targetUser.id);
      u.streakCount = 0; u.lastDaily = 0; u.lastDailyDay = null; // keep item
      saveDb();
      return msg.channel.send(`Reset ${targetUser.username}'s streak.`).catch(() => {});
    }
  }

  // Points command
  if (commandName === 'points') {
    const sub = (args.shift() || 'show').toLowerCase();
    const targetUser = msg.mentions.users.first() || msg.author;
    const u = ensureUser(msg.guild.id, targetUser.id);
    
    if (sub === 'show') {
      const points = u.points || { total: 0, snack: 0, cider: 0, trivia: 0, jumble: 0, heist: 0 };
      const highestRole = (() => {
        const wins = ensureUser(msg.guild.id, targetUser.id).wins || {};
        let best = 'No roles yet'; let bestLevel = 0;
        for (const [gameKey, roles] of Object.entries(minigameRoleRewards)) {
          const w = wins[gameKey] || 0;
          const thresholds = Object.keys(roles).map(n => parseInt(n,10)).sort((a,b)=>b-a);
          for (const t of thresholds) { if (w >= t) { if (t > bestLevel) { bestLevel = t; best = roles[t]; } break; } }
        }
        return best;
      })();
      
      const embed = new EmbedBuilder()
        .setColor(0xFFC0CB)
        .setTitle(`${targetUser.username}'s Points & Roles`)
        .addFields(
          { name: 'Total Points', value: `${points.total}`, inline: true },
          { name: 'Highest Role', value: highestRole, inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
          { name: 'Snack Game', value: `${points.snack} points`, inline: true },
          { name: 'Cider Press', value: `${points.cider} points`, inline: true },
          { name: 'Trivia Quiz', value: `${points.trivia} points`, inline: true },
          { name: 'Word Jumble', value: `${points.jumble} points`, inline: true },
          { name: 'Cookie Heist', value: `${points.heist} points`, inline: true },
          { name: '\u200B', value: '\u200B', inline: true }
        );
      
      return msg.channel.send({ embeds: [embed] }).catch(() => {});
    }
    
    if (sub === 'leaderboard') {
      const game = args[0];
      if (!game) {
        return msg.channel.send('Usage: !points leaderboard <game> (snack, cider, trivia, jumble, heist, total)').catch(() => {});
      }
      
      const guild = msg.guild;
      const allUsers = [];
      
      // Collect all users with points for this game
      for (const [userId, userData] of Object.entries(db.guilds[guild.id] || {})) {
        if (userData.points && userData.points[game] > 0) {
          try {
            const member = await guild.members.fetch(userId);
            allUsers.push({
              username: member.displayName || member.user.username,
              points: userData.points[game],
              totalPoints: userData.points.total || 0
            });
          } catch (e) {
            // User might have left the server
            continue;
          }
        }
      }
      
      // Sort by points (descending)
      allUsers.sort((a, b) => b.points - a.points);
      
      if (allUsers.length === 0) {
        return msg.channel.send(`No one has played ${game} yet!`).catch(() => {});
      }
      
      const gameNames = {
        total: 'All Games',
        snack: 'Snack Game',
        cider: 'Cider Press',
        trivia: 'Trivia Quiz',
        jumble: 'Word Jumble',
        heist: 'Cookie Heist'
      };
      
      const top10 = allUsers.slice(0, 10);
      const leaderboard = top10.map((user, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
        return `${medal} **${user.username}** - ${user.points} points`;
      }).join('\n');
      
      const embed = new EmbedBuilder()
        .setColor(0xFFC0CB)
        .setTitle(`${gameNames[game]} Leaderboard`)
        .setDescription(leaderboard)
        .setFooter({ text: `Showing top ${Math.min(10, allUsers.length)} players` });
      
      return msg.channel.send({ embeds: [embed] }).catch(() => {});
    }
    
    return msg.channel.send('Usage: !points show [@user] or !points leaderboard <game>').catch(() => {});
  }

  // Chat commands
  if (commandName === 'chat') {
    const message = args.join(' ').trim();
    if (!message) {
      return msg.channel.send('Usage: !chat <message>').catch(() => {});
    }
    
    msg.channel.sendTyping().catch(() => {});
    try {
      const response = await generateAIResponse(msg.author.id, message, msg.guild.id);
      await msg.channel.send(response).catch(() => {});
    } catch (error) {
      console.error('Chat command error:', error);
      await msg.channel.send("Sorry, I'm having trouble thinking right now. Maybe try again later! ☕").catch(() => {});
    }
    return;
  }

  if (commandName === 'clearmemory') {
    clearUserMemory(msg.author.id, msg.guild.id);
    return msg.channel.send("Your conversation memory with Glimmer has been cleared! 🧹✨").catch(() => {});
  }
});

// --- Helpers to show the public menu ---
function buildMenuRow(items) {
  const menu = new StringSelectMenuBuilder().setCustomId('order-menu').setPlaceholder('Choose your treat!');
  const opts = Object.entries(items).map(([key, it]) => ({ label: it.label, value: key, emoji: it.emoji }));
  menu.addOptions(opts.slice(0, 25)); // Discord limit
  return new ActionRowBuilder().addComponents(menu);
}
function buildMenuEmbed(items) {
  const list = Object.values(items).map(it => `${it.emoji} ${it.label}`);
  const half = Math.ceil(list.length / 2);
  return new EmbedBuilder()
    .setColor(0xFFC0CB)
    .setTitle('Glimmer Cafe Menu')
    .addFields(
      { name: 'Drinks & Treats', value: list.slice(0, half).join('\n') || '-', inline: true },
      { name: '\u200B', value: list.slice(half).join('\n') || '-', inline: true }
    )
    .setFooter({ text: 'Use /order or the menu below to place an order!' });
}
async function showMenu(interaction) {
  const items = menuItems();
  const row = buildMenuRow(items);
  const embed = buildMenuEmbed(items);
  return interaction.reply({ content: 'Welcome to Glimmer Cafe! What would you like?', embeds: [embed], components: [row] });
}

// --- Interactions (slash commands + select menus + buttons) ---
client.on(Events.InteractionCreate, async (interaction) => {
  const items = menuItems();

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // Food/drink commands (public)
    if (items[commandName]) {
      const target = interaction.options.getUser('to') ?? interaction.user;
      const embed = serveEmbed(items[commandName], `<@${target.id}>`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`refill:${commandName}:${target.id}`).setLabel('Refill').setStyle(ButtonStyle.Success)
      );
      return interaction.reply({ embeds: [embed], components: [row] }); // public
    }

    if (commandName === 'order' || commandName === 'menu') {
      return showMenu(interaction); // public
    }

    // Admin manual level management
    if (commandName === 'level') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'show') {
      const user = interaction.options.getUser('user') ?? interaction.user;
        const u = ensureUser(interaction.guildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(0xFFC0CB)
          .setTitle(`${user.username}'s Level`)
          .addFields({ name: 'Level', value: `${u.level}`, inline: true });
        return interaction.reply({ embeds: [embed] });
      }
      const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) return interaction.reply({ content: 'Administrator only.' });
      if (sub === 'set') {
        const user = interaction.options.getUser('user', true);
        const level = interaction.options.getInteger('level', true);
        const u = ensureUser(interaction.guildId, user.id);
        const prev = u.level || 0;
        const next = Math.max(0, level);
        u.level = next;
        saveDb();
        try {
          const member = await interaction.guild.members.fetch(user.id);
          await applyLevelRewards(member, prev, next);
          if (levelsChannelId && next > prev) {
            const ch = interaction.guild.channels.cache.get(levelsChannelId) || await interaction.guild.channels.fetch(levelsChannelId).catch(() => null);
            if (ch) {
              const name = member.displayName || member.user.username;
              ch.send(`${name} has reached level ${next}!`).catch(() => {});
            }
          }
        } catch (_) {}
        return interaction.reply({ content: `Set ${user.username}'s level to ${next}.` });
      }
      if (sub === 'add') {
        const user = interaction.options.getUser('user', true);
        const delta = interaction.options.getInteger('delta', true);
        const u = ensureUser(interaction.guildId, user.id);
        const prev = u.level || 0;
        const next = Math.max(0, prev + delta);
        u.level = next;
        saveDb();
        try {
          const member = await interaction.guild.members.fetch(user.id);
          await applyLevelRewards(member, prev, next);
          if (levelsChannelId && next > prev) {
            const ch = interaction.guild.channels.cache.get(levelsChannelId) || await interaction.guild.channels.fetch(levelsChannelId).catch(() => null);
            if (ch) {
              const name = member.displayName || member.user.username;
              ch.send(`${name} has reached level ${next}!`).catch(() => {});
            }
          }
        } catch (_) {}
        return interaction.reply({ content: `Adjusted ${user.username}'s level by ${next - prev}. New level: ${next}.` });
      }
    }

    // Minigames
    if (commandName === 'game') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'help') {
        const embed = new EmbedBuilder()
          .setColor(0xFFC0CB)
          .setTitle('Glimmer Cafe Minigames')
          .setDescription('Fun pony-themed games:')
        .addFields(
            { name: '/game snack', value: 'Guess the pony from snack hints. First correct wins! (+10 points)' },
            { name: '/game cider @opponent', value: 'Apple pressing duel! Most presses wins! (+15 points)' },
            { name: '/game trivia', value: 'Friendship Quiz with 50+ MLP questions! (+12 points)' },
            { name: '/game jumble', value: 'Unscramble pony names & locations! Speed bonus! (+8 points)' },
            { name: '/game heist', value: 'Team Cookie Caper heist! Team bonuses! (+20 points)' },
          );
        return interaction.reply({ embeds: [embed] });
      }

      // Simple in-memory game state (per channel)
      const channelId = interaction.channelId;
      global.__glimmerGames = global.__glimmerGames || { snack: {}, cider: {} };

      if (sub === 'snack') {
        if (global.__glimmerGames.snack[channelId]) {
          return interaction.reply({ content: 'A snack round is already running here. Please wait until it finishes.' });
        }
        const rounds = [
          { answer: 'Pinkie Pie', hints: ['Cupcakes', 'Party cannon', 'Sugarcube Corner'] },
          { answer: 'Applejack', hints: ['Zap apples', 'Sweet Apple Acres', 'Honesty'] },
          { answer: 'Rarity', hints: ['Gems', 'Carousel Boutique', 'Fashion'] },
          { answer: 'Rainbow Dash', hints: ['20% cooler', 'Wonderbolts', 'Sonic Rainboom'] },
          { answer: 'Fluttershy', hints: ['Animals', 'Stare', 'Kindness'] },
          { answer: 'Twilight Sparkle', hints: ['Books', 'Magic', 'Friendship lessons'] },
        ];
        const pick = rounds[Math.floor(Math.random() * rounds.length)];
        global.__glimmerGames.snack[channelId] = { answer: pick.answer.toLowerCase(), over: false };
        const hintText = pick.hints.map((h, i) => `Hint ${i + 1}: ${h}`).join('\n');
        await interaction.reply({ content: `Who's Snack Is It Anyway?\n${hintText}\nReply the pony name in chat!` });
        // Listen for first correct answer for 30s
        const filter = m => !m.author.bot && m.channelId === channelId;
        const collector = interaction.channel.createMessageCollector({ filter, time: 30_000 });
        collector.on('collect', async (m) => {
          const guess = m.content.trim().toLowerCase();
          const state = global.__glimmerGames.snack[channelId];
          if (!state || state.over) return;
          if (guess.includes(state.answer)) {
            state.over = true;
            collector.stop('win');
            await interaction.followUp({ content: `Correct! ${m.author} guessed ${pick.answer}!` });
            await recordWin(interaction.guild, m.author.id, 'snack');
          }
        });
        collector.on('end', async (_, reason) => {
          const state = global.__glimmerGames.snack[channelId];
          delete global.__glimmerGames.snack[channelId];
          if (reason !== 'win') {
            await interaction.followUp({ content: `Time's up! The answer was ${pick.answer}.` }).catch(() => {});
          }
        });
        return;
      }

      if (sub === 'cider') {
        const opponent = interaction.options.getUser('opponent', true);
        const challenger = interaction.user;
        if (opponent.bot || opponent.id === challenger.id) {
          return interaction.reply({ content: 'Pick a valid, non-bot opponent.' });
        }
        const key = `${interaction.channelId}`;
        global.__glimmerGames.cider[key] = { 
          scores: { [challenger.id]: 0, [opponent.id]: 0 }, 
          over: false,
          startTime: Date.now(),
          pressCount: 0
        };
        
        // Enhanced cider press with different button styles and emojis
        const makeBtn = (id, label, emoji) => new ButtonBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setEmoji(emoji)
          .setStyle(ButtonStyle.Success);
        
        const row = new ActionRowBuilder().addComponents(
          makeBtn(`cider:${challenger.id}`, 'Press!', '🍎'),
          makeBtn(`cider:${opponent.id}`, 'Press!', '🍎'),
        );
        
        // Fun challenge messages
        const challengeMessages = [
          `🍎 **Cider Press Showdown!** ${challenger} vs ${opponent} — Who can press the most apples? (10 seconds!)`,
          `⚡ **Apple Squeezing Contest!** ${challenger} vs ${opponent} — First to 10 presses wins! (10 seconds!)`,
          `🥤 **Cider Making Duel!** ${challenger} vs ${opponent} — Press those apples! (10 seconds!)`,
          `🍯 **Sweet Apple Showdown!** ${challenger} vs ${opponent} — Who's the better presser? (10 seconds!)`
        ];
        
        const challengeMessage = challengeMessages[Math.floor(Math.random() * challengeMessages.length)];
        await interaction.reply({ content: challengeMessage, components: [row] });
        
        setTimeout(async () => {
          const state = global.__glimmerGames.cider[key];
          if (!state || state.over) return;
          state.over = true;
          const [a, b] = [state.scores[challenger.id] || 0, state.scores[opponent.id] || 0];
          
          // Enhanced result messages with different outcomes
          let result = `🍎 **Cider Press Results:**\n${challenger.username}: ${a} presses | ${opponent.username}: ${b} presses\n\n`;
          
          if (a === b) {
            result += `🤝 **It's a tie!** Big Mac says: "Eeyup." Both ponies are equally good at pressing!`;
          } else {
            const winnerId = a > b ? challenger.id : opponent.id;
            const winner = a > b ? challenger : opponent;
            const loser = a > b ? opponent : challenger;
            const winnerScore = Math.max(a, b);
            const loserScore = Math.min(a, b);
            
            // Different victory messages based on score difference
            if (winnerScore >= 15) {
              result += `🏆 **DOMINATING VICTORY!** ${winner.username} crushed it with ${winnerScore} presses! ${loser.username} only got ${loserScore}.`;
            } else if (winnerScore >= 10) {
              result += `🥇 **Great Win!** ${winner.username} won with ${winnerScore} presses! ${loser.username} got ${loserScore}.`;
            } else if (winnerScore >= 5) {
              result += `🍎 **Good Win!** ${winner.username} won with ${winnerScore} presses! ${loser.username} got ${loserScore}.`;
            } else {
              result += `🍯 **Close Win!** ${winner.username} barely won with ${winnerScore} presses! ${loser.username} got ${loserScore}.`;
            }
            
            // Award points to winner
            const points = await awardPoints(interaction.guild, winnerId, 'cider');
            await recordWin(interaction.guild, winnerId, 'cider');
            result += `\n💰 ${winner.username} earned ${points} points!`;
          }
          
          await interaction.followUp({ content: result }).catch(() => {});
          delete global.__glimmerGames.cider[key];
        }, 10_000);
        return;
      }

      // Placeholders for later expansions
      if (sub === 'trivia') {
        global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };
        const q = pickTriviaQuestion();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`trivia:A`).setLabel(q.choices[0]).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`trivia:B`).setLabel(q.choices[1]).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`trivia:C`).setLabel(q.choices[2]).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`trivia:D`).setLabel(q.choices[3]).setStyle(ButtonStyle.Primary),
        );
        global.__glimmerGames.trivia[interaction.channelId] = { correct: q.answer, askedAt: Date.now(), over: false };
        await interaction.reply({ content: `🧠 **Friendship Quiz:**\n${q.question}`, components: [row] });
        setTimeout(() => {
          const state = global.__glimmerGames.trivia[interaction.channelId];
          if (state && !state.over) {
            interaction.followUp({ content: `⏰ Time's up! The correct answer was **${q.answer}**.` }).catch(() => {});
            delete global.__glimmerGames.trivia[interaction.channelId];
          }
        }, 20_000);
        return;
      }

      if (sub === 'jumble') {
        global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };
        const word = pickJumbleWord();
        const jumbled = jumbleWord(word);
        if (global.__glimmerGames.jumble[interaction.channelId]) {
          return interaction.reply({ content: 'A jumble round is already running here. Please wait.' });
        }
        global.__glimmerGames.jumble[interaction.channelId] = { answer: word.toLowerCase(), over: false, startedAt: Date.now() };
        await interaction.reply({ content: `🔤 **Cutie Mark Jumble!** Unscramble: **${jumbled}** (20s)\n💡 *Tip: punctuation and spacing are ignored when guessing.*` });
        const filter = m => !m.author.bot && m.channelId === interaction.channelId;
        const col = interaction.channel.createMessageCollector({ filter, time: 20_000 });
        
        // Add hint timer
        const hintTimer = setTimeout(() => {
          try { interaction.followUp({ content: `💡 **Hint:** the answer starts with **${word[0]}**` }).catch(() => {}); } catch (_) {}
        }, 10_000);
        
        const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        
        col.on('collect', async (m) => {
          const guess = normalize(m.content);
          const state = global.__glimmerGames.jumble[interaction.channelId];
          if (!state || state.over) return;
          if (guess === normalize(state.answer)) {
            state.over = true; col.stop('win');
            clearTimeout(hintTimer);
            
            const elapsed = Date.now() - (state.startedAt || Date.now());
            const points = await awardPoints(interaction.guild, m.author.id, 'jumble');
            await recordWin(interaction.guild, m.author.id, 'jumble');
            
            let bonus = 0;
            if (elapsed < 6_000) {
              bonus = 5;
              const u = ensureUser(interaction.guild.id, m.author.id);
              u.points = u.points || {}; u.points.jumble = (u.points.jumble || 0) + bonus; u.points.total = (u.points.total || 0) + bonus;
              saveDb();
            }
            
            const message = `🎉 **Correct!** ${m.author} unscrambled **${word}**! (+${points + bonus} points${bonus ? ` — including ${bonus}-point speed bonus` : ''})`;
            interaction.followUp({ content: message }).catch(() => {});
          }
        });
        col.on('end', (_, reason) => {
          clearTimeout(hintTimer);
          const state = global.__glimmerGames.jumble[interaction.channelId];
          delete global.__glimmerGames.jumble[interaction.channelId];
          if (reason !== 'win') interaction.followUp({ content: `⏰ Time's up! The word was **${word}**.` }).catch(() => {});
        });
        return;
      }

      if (sub === 'heist') {
        global.__glimmerGames = global.__glimmerGames || { trivia: {}, jumble: {}, heist: {}, snack: {}, cider: {} };
        if (global.__glimmerGames.heist[interaction.channelId]) return interaction.reply({ content: 'A heist is already forming here.' });
        const joinId = `heist-join:${interaction.channelId}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(joinId).setLabel('Join Heist').setStyle(ButtonStyle.Success)
        );
        global.__glimmerGames.heist[interaction.channelId] = { members: new Set([interaction.user.id]), over: false };
        await interaction.reply({ content: 'Cookie Caper forming! Click to join (15s).', components: [row] });
        setTimeout(async () => {
          const state = global.__glimmerGames.heist[interaction.channelId];
          if (!state || state.over) return;
          state.over = true;
          const count = state.members.size;
          delete global.__glimmerGames.heist[interaction.channelId];
          if (count === 0) return interaction.followUp({ content: 'No one joined the heist.' }).catch(() => {});
          
          // Enhanced heist mechanics with different outcomes
          const baseSuccessChance = Math.min(85, 25 + count * 12);
          const roll = Math.floor(Math.random() * 100) + 1;
          
          // Special bonus for certain team sizes
          let bonus = 0;
          if (count === 6) bonus = 10; // Perfect Mane 6 team
          else if (count === 3) bonus = 5; // Cutie Mark Crusaders team
          else if (count >= 8) bonus = 8; // Large team bonus
          
          const successChance = Math.min(95, baseSuccessChance + bonus);
          
          // Different outcomes based on roll
          if (roll <= successChance) {
            const members = Array.from(state.members);
            const points = await awardPoints(interaction.guild, members[0], 'heist');
            await Promise.all(members.map(uid => recordWin(interaction.guild, uid, 'heist')));

            // Different success messages based on performance
            let successMessage = '';
            if (roll <= 20) {
              successMessage = `🎉 **PERFECT HEIST!** ${count} friends executed the Cookie Caper flawlessly! (roll ${roll} ≤ ${successChance})`;
            } else if (roll <= 50) {
              successMessage = `🍪 **Great Success!** ${count} friends pulled off the Cookie Caper! (roll ${roll} ≤ ${successChance})`;
            } else {
              successMessage = `🍪 **Success!** ${count} friends managed the Cookie Caper! (roll ${roll} ≤ ${successChance})`;
            }
            
            if (bonus > 0) {
              successMessage += `\n✨ **Team Bonus:** +${bonus}% for ${count === 6 ? 'perfect Mane 6 team' : count === 3 ? 'Cutie Mark Crusaders team' : 'large team'}!`;
            }
            
            successMessage += `\n💰 Each member earned ${points} points!`;
            
            return interaction.followUp({ content: successMessage }).catch(() => {});
          } else {
            // Different failure messages
            let failureMessage = '';
            if (roll >= 95) {
              failureMessage = `💥 **Catastrophic Failure!** The Cookie Caper was completely foiled! (roll ${roll} > ${successChance})`;
            } else if (roll >= 85) {
              failureMessage = `😱 **Major Setback!** Discord's chaos ruined the Cookie Caper! (roll ${roll} > ${successChance})`;
            } else {
              failureMessage = `😔 **Foiled!** The Cookie Caper didn't go as planned. (roll ${roll} > ${successChance})`;
            }
            
            return interaction.followUp({ content: failureMessage }).catch(() => {});
          }
        }, 15_000);
        return;
      }
    }

    if (commandName === 'daily') {
      // Daily streak: choose item, continue/reset streak, grant XP
      const chosen = interaction.options.getString('item'); // key
      const u = ensureUser(interaction.guildId, interaction.user.id);
      const now = Date.now();
    const today = dayIndexDaily(now);

      if (u.lastDailyDay === today) {
        const label = u.streakItem ? items[u.streakItem].label : 'your item';
        return interaction.reply({ content: `You already claimed your daily ${label} today. Streak: ${u.streakCount} day(s).` });
      }

      if (chosen) u.streakItem = chosen;
      if (!u.streakItem) {
        return interaction.reply({ content: 'Pick your streak item with /daily item:<choice> (this sets what you come back for each day).' });
      }

      // streak logic
      const prevStreak = u.streakCount || 0;
      if (u.lastDailyDay == null || today - u.lastDailyDay > 1) {
        u.streakCount = 1; // reset
      } else if (today - u.lastDailyDay === 1) {
        u.streakCount += 1; // continue
      } else {
        // first time today
        u.streakCount = Math.max(1, u.streakCount);
      }
      u.lastDailyDay = today;
      u.lastDaily = now;

      // Apply streak rewards if streak increased
      if (u.streakCount > prevStreak) {
        try {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await applyStreakRewards(member, prevStreak, u.streakCount);
          await grantPlaceholderRole(member);
        } catch (e) {
          console.error('Streak reward error:', e);
        }
      }

      const it = items[u.streakItem];
      const text = `${it.emoji} Daily ${it.label} recorded! Streak: ${u.streakCount} day(s).`;
      await interaction.reply({ content: text });

      // Optional: post streak milestones publicly (e.g., every 7 days)
      if (levelsChannelId && (u.streakCount % 7 === 0)) {
        const ch = interaction.guild.channels.cache.get(levelsChannelId)
          || await interaction.guild.channels.fetch(levelsChannelId).catch(() => null);
        if (ch) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const name = member.displayName || member.user.username;
          ch.send(`${name} kept their ${it.label} streak for ${u.streakCount} days!`).catch(() => {});
        }
      }

      return;
    }

    if (commandName === 'streak') {
      const sub = interaction.options.getSubcommand();
      const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
      const gId = interaction.guildId;

      if (sub === 'show') {
        const user = interaction.options.getUser('user') ?? interaction.user;
        const u = ensureUser(gId, user.id);
        const itemsMap = menuItems();
        const label = u.streakItem ? itemsMap[u.streakItem]?.label || 'Unknown' : 'None';
        const last = u.lastDaily ? new Date(u.lastDaily).toLocaleString() : 'Never';
        const embed = new EmbedBuilder()
          .setColor(0xFFC0CB)
          .setTitle(`${user.username}'s Daily Streak`)
          .addFields(
            { name: 'Item', value: label, inline: true },
            { name: 'Streak', value: `${u.streakCount} day(s)`, inline: true },
            { name: 'Last Claimed', value: last }
          );

        return interaction.reply({ embeds: [embed] });
      }

      if (!isAdmin) {
        return interaction.reply({ content: 'Administrator only.' });
      }

      if (sub === 'set') {
        const user = interaction.options.getUser('user', true);
        const count = interaction.options.getInteger('count', true);
        const item = interaction.options.getString('item');
        const u = ensureUser(gId, user.id);
        const prevStreak = u.streakCount || 0;
        u.streakCount = Math.max(0, count);
        if (item) u.streakItem = item;
        saveDb();
        // Apply streak rewards if streak increased
        if (count > prevStreak) {
          try {
            const member = await interaction.guild.members.fetch(user.id);
            await applyStreakRewards(member, prevStreak, count);
          } catch (e) {
            console.error('Streak reward error:', e);
          }
        }
        const itemsMap = menuItems();
        const label = u.streakItem ? itemsMap[u.streakItem].label : 'None';
        return interaction.reply({ content: `Set ${user.username}'s streak to ${u.streakCount} (item: ${label}).` });
      }

      if (sub === 'add') {
        const user = interaction.options.getUser('user', true);
        const delta = interaction.options.getInteger('delta', true);
        const u = ensureUser(gId, user.id);
        const prevStreak = u.streakCount || 0;
        u.streakCount = Math.max(0, prevStreak + delta);
        saveDb();
        // Apply streak rewards if streak increased
        if (u.streakCount > prevStreak) {
          try {
            const member = await interaction.guild.members.fetch(user.id);
            await applyStreakRewards(member, prevStreak, u.streakCount);
          } catch (e) {
            console.error('Streak reward error:', e);
          }
        }
        return interaction.reply({ content: `Adjusted ${user.username}'s streak by ${delta}. New streak: ${u.streakCount}.` });
      }

      if (sub === 'reset') {
        const user = interaction.options.getUser('user', true);
        const u = ensureUser(gId, user.id);
        u.streakCount = 0; u.lastDaily = 0; u.lastDailyDay = null; // keep item
        saveDb();
        return interaction.reply({ content: `Reset ${user.username}'s streak.` });
      }
    }

    if (commandName === 'points') {
      const sub = interaction.options.getSubcommand();
      const user = interaction.options.getUser('user') ?? interaction.user;
      const u = ensureUser(interaction.guildId, user.id);
      
      if (sub === 'show') {
        const points = u.points || { total: 0, snack: 0, cider: 0, trivia: 0, jumble: 0, heist: 0 };
        const highestRole = (() => {
          const wins = ensureUser(interaction.guildId, user.id).wins || {};
          let best = 'No roles yet'; let bestLevel = 0;
          for (const [gameKey, roles] of Object.entries(minigameRoleRewards)) {
            const w = wins[gameKey] || 0;
            const thresholds = Object.keys(roles).map(n => parseInt(n,10)).sort((a,b)=>b-a);
            for (const t of thresholds) { if (w >= t) { if (t > bestLevel) { bestLevel = t; best = roles[t]; } break; } }
          }
          return best;
        })();
        
        const embed = new EmbedBuilder()
          .setColor(0xFFC0CB)
          .setTitle(`${user.username}'s Points & Roles`)
          .addFields(
            { name: 'Total Points', value: `${points.total}`, inline: true },
            { name: 'Highest Role', value: highestRole, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Snack Game', value: `${points.snack} points`, inline: true },
            { name: 'Cider Press', value: `${points.cider} points`, inline: true },
            { name: 'Trivia Quiz', value: `${points.trivia} points`, inline: true },
            { name: 'Word Jumble', value: `${points.jumble} points`, inline: true },
            { name: 'Cookie Heist', value: `${points.heist} points`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true }
          );
        
        return interaction.reply({ embeds: [embed] });
      }
      
      if (sub === 'leaderboard') {
        const game = interaction.options.getString('game', true);
        const guild = interaction.guild;
        const allUsers = [];
        
        // Collect all users with points for this game
        for (const [userId, userData] of Object.entries(db.guilds[guild.id] || {})) {
          if (userData.points && userData.points[game] > 0) {
            try {
              const member = await guild.members.fetch(userId);
              allUsers.push({
                username: member.displayName || member.user.username,
                points: userData.points[game],
                totalPoints: userData.points.total || 0
              });
            } catch (e) {
              // User might have left the server
              continue;
            }
          }
        }
        
        // Sort by points (descending)
        allUsers.sort((a, b) => b.points - a.points);
        
        if (allUsers.length === 0) {
          return interaction.reply({ content: `No one has played ${game} yet!` });
        }
        
        const gameNames = {
          total: 'All Games',
          snack: 'Snack Game',
          cider: 'Cider Press',
          trivia: 'Trivia Quiz',
          jumble: 'Word Jumble',
          heist: 'Cookie Heist'
        };
        
        const top10 = allUsers.slice(0, 10);
        const leaderboard = top10.map((user, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
          return `${medal} **${user.username}** - ${user.points} points`;
        }).join('\n');
        
        const embed = new EmbedBuilder()
          .setColor(0xFFC0CB)
          .setTitle(`${gameNames[game]} Leaderboard`)
          .setDescription(leaderboard)
          .setFooter({ text: `Showing top ${Math.min(10, allUsers.length)} players` });
        
        return interaction.reply({ embeds: [embed] });
      }
    }

    if (commandName === 'chat') {
      const message = interaction.options.getString('message', true);
      await interaction.deferReply();
      
      try {
        const response = await generateAIResponse(interaction.user.id, message, interaction.guildId);
        await interaction.editReply(response);
      } catch (error) {
        console.error('Chat command error:', error);
        await interaction.editReply("Sorry, I'm having trouble thinking right now. Maybe try again later! ☕");
      }
      return;
    }

    if (commandName === 'clearmemory') {
      clearUserMemory(interaction.user.id, interaction.guildId);
      return interaction.reply({ content: "Your conversation memory with Glimmer has been cleared! 🧹✨" });
    }

    if (commandName === 'birthday') {
      const sub = interaction.options.getSubcommand();
      const u = ensureUser(interaction.guildId, interaction.user.id);
      if (sub === 'set') {
        const m = interaction.options.getInteger('month', true);
        const d = interaction.options.getInteger('day', true);
        if (m < 1 || m > 12 || d < 1 || d > 31) {
          return interaction.reply({ content: 'Please provide a valid date (month 1-12, day 1-31).' });
        }
        u.birthday.month = m; u.birthday.day = d; saveDb();
        return interaction.reply({ content: `Saved your birthday as ${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}.` });
      }
      if (sub === 'show') {
        if (u.birthday?.month && u.birthday?.day) {
          return interaction.reply({ content: `Your birthday on file is ${String(u.birthday.month).padStart(2,'0')}-${String(u.birthday.day).padStart(2,'0')}.` });
        }
        return interaction.reply({ content: 'You have not set a birthday. Use /birthday set.' });
      }
      if (sub === 'remove') {
        u.birthday = { month: null, day: null, lastYearCelebrated: null }; saveDb();
        return interaction.reply({ content: 'Removed your saved birthday.' });
      }
    }
  }

  // Select menu (public)
  if (interaction.isStringSelectMenu() && interaction.customId === 'order-menu') {
    const key = interaction.values[0];
    const it = items[key];
    const embed = serveEmbed(it, `<@${interaction.user.id}>`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`refill:${key}:${interaction.user.id}`).setLabel('Refill').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('order-again').setLabel('Order something else').setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ content: `Your ${it.label} is ready!`, embeds: [embed], components: [row] });
  }

  // Buttons (public)
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('refill:')) {
      const [, key, uid] = interaction.customId.split(':');
      const itemsMap = menuItems();
      const it = itemsMap[key];
      const target = uid ? `<@${uid}>` : `<@${interaction.user.id}>`;
      const embed = serveEmbed(it, target);
      return interaction.reply({ content: 'Refill coming right up!', embeds: [embed] });
    }
    if (interaction.customId === 'order-again') {
      const itemsMap = menuItems();
      const row = buildMenuRow(itemsMap);
      const embed = buildMenuEmbed(itemsMap);
      return interaction.update({ content: 'What would you like this time?', embeds: [embed], components: [row] });
    }
    // Cider duel presses
    if (interaction.customId.startsWith('cider:')) {
      const [, userId] = interaction.customId.split(':');
      const key = `${interaction.channelId}`;
      const state = global.__glimmerGames?.cider?.[key];
      if (!state || state.over) return interaction.reply({ content: 'Round over!', ephemeral: true }).catch(() => {});
      if (![userId].includes(interaction.user.id)) return interaction.reply({ content: 'This button is not for you!', ephemeral: true }).catch(() => {});
      state.scores[interaction.user.id] = (state.scores[interaction.user.id] || 0) + 1;
      return interaction.deferUpdate().catch(() => {});
    }
    // Trivia answer buttons
    if (interaction.customId.startsWith('trivia:')) {
      const key = interaction.channelId;
      const state = global.__glimmerGames?.trivia?.[key];
      if (!state || state.over) return interaction.reply({ content: 'Round over!', ephemeral: true }).catch(() => {});
      const picked = interaction.customId.split(':')[1];
      if (picked === state.correct) {
        state.over = true;
        delete global.__glimmerGames.trivia[key];
        const points = await awardPoints(interaction.guild, interaction.user.id, 'trivia');
        await recordWin(interaction.guild, interaction.user.id, 'trivia');
        return interaction.reply({ content: `🎉 **Correct!** ${interaction.user} answered **${picked}**! (+${points} points)` }).catch(() => {});
      } else {
        return interaction.reply({ content: '❌ Not quite, try again!', ephemeral: true }).catch(() => {});
      }
    }
    // Heist join button
    if (interaction.customId.startsWith('heist-join:')) {
      const chId = interaction.customId.split(':')[1];
      const state = global.__glimmerGames?.heist?.[chId];
      if (!state || state.over) return interaction.reply({ content: 'Heist already started.', ephemeral: true }).catch(() => {});
      state.members.add(interaction.user.id);
      return interaction.reply({ content: 'Joined the heist!', ephemeral: true }).catch(() => {});
    }
  }
});

// --- Start bot ---
client.login(process.env.TOKEN);

// Cloud hosting optimizations
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process in cloud hosting
});

// Graceful shutdown handling for cloud hosting
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  saveDb(); // Save database before shutdown
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  saveDb(); // Save database before shutdown
  process.exit(0);
});

// Export functions for testing
module.exports = {
  generateAIResponse,
  clearUserMemory,

};
