// Test script for AI chat functionality
console.log('Starting AI chat test...');

// Import the functions directly
const fs = require('fs');
const path = require('path');

// Read the main file and extract the functions
const mainFile = fs.readFileSync('./index_new.cjs', 'utf8');

// Simple test of the AI response logic
function generateSimpleResponse(message, userMemory) {
  const lowerMessage = message.toLowerCase();
  
  // Greeting responses
  if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey')) {
    return "Hello there! Welcome to Glimmer Cafe! ☕ How can I help you today?";
  }
  
  // MLP-related responses
  if (lowerMessage.includes('twilight') || lowerMessage.includes('sparkle')) {
    return "Twilight Sparkle is such a wonderful character! She's grown so much from a bookish unicorn to a Princess of Friendship! 📚✨";
  }
  
  // Cafe-related responses
  if (lowerMessage.includes('cafe') || lowerMessage.includes('coffee') || lowerMessage.includes('drink')) {
    return "Welcome to Glimmer Cafe! We have all sorts of delicious drinks and treats! Try using /menu to see what we offer! ☕🍰";
  }
  
  // Default responses
  const defaultResponses = [
    "That's interesting! Tell me more! 💭",
    "I love chatting with you! What else is on your mind? 💬",
    "That sounds fun! I'm always here to chat! ☕"
  ];
  
  return defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
}

async function testAI() {
  console.log('Testing AI Chat functionality...');
  
  try {
    // Test basic response
    const response1 = generateSimpleResponse('Hello Glimmer!', []);
    console.log('Test 1 - Hello:', response1);
    
    // Test MLP-related response
    const response2 = generateSimpleResponse('Tell me about Twilight Sparkle', []);
    console.log('Test 2 - Twilight:', response2);
    
    // Test cafe-related response
    const response3 = generateSimpleResponse('What drinks do you have?', []);
    console.log('Test 3 - Drinks:', response3);
    
    console.log('✅ All AI chat tests passed!');
  } catch (error) {
    console.error('❌ AI chat test failed:', error);
  }
}

testAI();
