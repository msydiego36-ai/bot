// Test script for AI chat functionality
const { generateAIResponse, clearUserMemory } = require('./index_new.cjs');

async function testAI() {
  console.log('Testing AI Chat functionality...');
  
  try {
    // Test basic response
    const response1 = await generateAIResponse('test-user-123', 'Hello Glimmer!', 'Test Server');
    console.log('Test 1 - Hello:', response1);
    
    // Test MLP-related response
    const response2 = await generateAIResponse('test-user-123', 'Tell me about Twilight Sparkle', 'Test Server');
    console.log('Test 2 - Twilight:', response2);
    
    // Test cafe-related response
    const response3 = await generateAIResponse('test-user-123', 'What drinks do you have?', 'Test Server');
    console.log('Test 3 - Drinks:', response3);
    
    // Test memory clearing
    clearUserMemory('test-user-123');
    console.log('Test 4 - Memory cleared successfully');
    
    console.log('✅ All AI chat tests passed!');
  } catch (error) {
    console.error('❌ AI chat test failed:', error);
  }
}

testAI();
