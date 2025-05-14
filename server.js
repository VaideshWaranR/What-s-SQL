// Required dependencies
const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const twilio = require('twilio');
require('dotenv').config();
let req_message='';
// Initialize Express app
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model:'gemini-1.5-flash'});
let targetLanguage='Tamil'
// PostgreSQL client configuration
const dbClient = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// Connect to PostgreSQL
dbClient.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('PostgreSQL connection error:', err));


async function getDatabaseSchema() {
  try {
    // Query to get all tables
    const tablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    const tables = await dbClient.query(tablesQuery);
    
    let schemaInfo = '';
    
    for (const table of tables.rows) {
      const tableName = table.table_name;
      schemaInfo += `Table: ${tableName}\nColumns:\n`;
      
      const columnsQuery = `
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1
      `;
      const columns = await dbClient.query(columnsQuery, [tableName]);
      
      for (const column of columns.rows) {
        schemaInfo += `- ${column.column_name} (${column.data_type})\n`;
      }
      
      schemaInfo += '\n';
    }
    
    return schemaInfo;
  } catch (error) {
    console.error('Error fetching schema:', error);
    return 'Error fetching database schema';
  }
}

// Function to convert natural language to SQL using Gemini
async function generateSQLFromNaturalLanguage(userQuery, dbSchema) {
  try {
    const prompt = `
    Given the following PostgreSQL database schema:
    ${dbSchema}
    
    Convert this natural language query to a SQL query:
    "${userQuery}"
    
    Return only the SQL query without any explanation or markdown formatting. The query should start with SELECT and be optimized for PostgreSQL.
    `;

    const result = await model.generateContent(prompt);
    const sqlQuery = result.response.text().trim();
    console.log(sqlQuery)
    // Security checks - basic SQL injection prevention
    const dangerousKeywords = ['drop', 'delete', 'truncate', 'insert', 'alter', ];//'create','update'
    if (dangerousKeywords.some(keyword => sqlQuery.toLowerCase().includes(keyword))) {
      throw new Error("This query appears to modify the database which is not allowed");
    }
    
    // Only allow SELECT statements
    if (!sqlQuery.toLowerCase().trim().startsWith("select")) {
      throw new Error("Only SELECT queries are allowed");
    }

    return sqlQuery;
  } catch (error) {
    console.error('Error generating SQL:', error);
    throw new Error(`Failed to generate SQL: ${error.message}`);
  }
}

// Function to execute SQL query
async function executeQuery(sqlQuery) {
  try {
    const result = await dbClient.query(sqlQuery);
    console.log(result)
    return result.rows;
  } catch (error) {
    console.error('Error executing query:', error);
    throw new Error(`Database query error: ${error.message}`);
  }
}


async function translateMessage(userMessage) {
  const prompt = `
Translate the following message into ${targetLanguage}:

"${userMessage}"

Return only the translated text without any extra comments or formatting.
  `;
  if (translateMessage==='English') return userMessage;
  
  const result = await model.generateContent(prompt);
  const response = await result.response.text();
  return response.trim();
}

// Function to format results for WhatsApp
function formatResults(results, originalQuery) {
  if (!results || results.length === 0) {
    return "No results found for your query.";
  }
  
  // For small result sets, return as formatted text
  let response = "Results :\n\n";
  
  // Get column names from the first result
  const columns = Object.keys(results[0]);
  
  // Simple table format for WhatsApp
  if (results.length <= 10) {
    results.forEach((row, index) => {
      response += `*Row ${index + 1}*\n`;
      columns.forEach(col => {
        response += `${col}: ${row[col]}\n`;
      });
      response += '\n';
    });
  } else {
    // For larger result sets, summarize
    response += `Found ${results.length} records. Here are the first 5:\n\n`;
    
    results.slice(0, 5).forEach((row, index) => {
      response += `*Row ${index + 1}*\n`;
      columns.forEach(col => {
        response += `${col}: ${row[col]}\n`;
      });
      response += '\n';
    });
    
    response += `... and ${results.length - 5} more records.`;
  }
  
  return response;
}

// Process the incoming query
async function processQuery(userQuery) {
  try {
    // Get database schema
    const dbSchema = await getDatabaseSchema();
    
    // Generate SQL from natural language
    const sqlQuery = await generateSQLFromNaturalLanguage(userQuery, dbSchema);
    console.log('Generated SQL:', sqlQuery);
    
    // Execute the query
    const results = await executeQuery(sqlQuery);
    
    // Format the results
    const formatted_results=formatResults(results, userQuery);
    return translateMessage(formatted_results);
  } catch (error) {
    return `Sorry, I couldn't process your request: ${error.message}`;
  }
}

// WhatsApp webhook endpoint
app.post('/whatsapp', async (req, res) => {

  console.log('Message recieved')
  const incomingMsg = req.body.Body || '';
  const sender = req.body.From || '';
  if(incomingMsg==='1') {
    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: 'whatsapp:+14155238886', // Twilio sandbox number
      to: `whatsapp:+91${process.env.SENDER_PHONE}`,  // Your WhatsApp number
      body: "Accepted"
    });
    await client.messages.create({
      from: 'whatsapp:+14155238886', // Twilio sandbox number
      to: `whatsapp:+91${process.env.RECIEVER_PHONE}`,// Your WhatsApp number
      body: req_message
    });
    console.log("Accepted")
    return;
  } else if(incomingMsg==='2') {
    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: 'whatsapp:+14155238886', // Twilio sandbox number
     to: `whatsapp:+91${process.env.SENDER_PHONE}`,  // Your WhatsApp number    
      body: "Rejected"
    });
    console.log("Rejected")
    return;
  }
  console.log(`Received message from ${sender}: ${incomingMsg}`);
  
  // Process the user query
  const response = await processQuery(incomingMsg);
  
  // Send response using Twilio
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(response);
  
  res.writeHead(200, {'Content-Type': 'text/xml'});
  res.end(twiml.toString());
});

// Alternative API endpoint for direct testing without WhatsApp
app.post('/api/query', async (req, res) => {
  try{
    checkLowStockAndAlert();
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Inventory alert function
async function checkLowStockAndAlert() {
  try {
    const lowStockQuery = `
      SELECT name, stock_quantity
      FROM inventory 
      WHERE stock_quantity <= 101;
    `;
    const result = await dbClient.query(lowStockQuery);
    const lowStockItems = result.rows;

    if (lowStockItems.length === 0) {
      console.log("✅ Inventory levels are sufficient.");
      return;
    }

    let message = `🚨 *Low Stock Alert*\n\n`;
    req_message='Refill Request\n'
    lowStockItems.forEach(item => {
      message += `*${item.name}* is low.\nAvailable: ${item.stock_quantity}, Minimum required: 100\n\n`;
      req_message+=`*${item.name} quantity -100 *\n`;
    });
    
    message += `⚠️ Please restock soon. Input 1.Accept 2.Reject`;

    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    
    await client.messages.create({
      from: 'whatsapp:+14155238886', // Twilio sandbox number
     to: `whatsapp:+91${process.env.SENDER_PHONE}`,   // Your WhatsApp number
      body: message
    });

    console.log("✅ Low stock alert sent via WhatsApp.");
  } catch (error) {
    console.error("❌ Error in stock alert:", error.message);
  }
}


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});