import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import OpenAI from "openai";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function sendToGoogleSheet(threadId) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const messagesList = await client.beta.threads.messages.list(threadId);
    let transcript = "";
    let finalBotMessage = "";
    for (const message of messagesList.data.reverse()) {
      const role = message.role === "user" ? "User" : "Assistant";
      const content = message.content[0].text.value;
      transcript += `${role}: ${content}\n\n`;
      if (message.role === 'assistant') {
        finalBotMessage = content;
      }
    }
    const jsonMatch = finalBotMessage.match(/```json\s*([\s\S]*?)\s*```/);
    let contactInfo = { name: "Not provided", company: "Not provided", email: "Not provided", phone: "Not provided" };
    if (jsonMatch && jsonMatch[1]) {
      contactInfo = JSON.parse(jsonMatch[1]);
    }
    const newRow = [ new Date().toISOString(), contactInfo.name || "Not provided", contactInfo.company || "Not provided", contactInfo.email || "Not provided", contactInfo.phone || "Not provided", transcript.trim(), threadId ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "Sheet1!A:G",
      valueInputOption: "USER_ENTERED",
      resource: { values: [newRow] },
    });
    console.log(`Successfully added lead to Google Sheet for thread ${threadId}`);
  } catch (error) {
    console.error("Error sending data to Google Sheets:", error);
  }
}

app.post("/start", async (req, res) => {
  try {
    const thread = await client.beta.threads.create();
    res.json({ threadId: thread.id });
  } catch (error) {
    console.error("Error creating thread:", error);
    res.status(500).json({ error: "Could not start conversation." });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const { message: userMessage, threadId: existingThreadId } = req.body;
    let thread;
    if (existingThreadId) { thread = { id: existingThreadId }; } 
    else { thread = await client.beta.threads.create(); }
    await client.beta.threads.messages.create(thread.id, { role: "user", content: userMessage });
    const run = await client.beta.threads.runs.create(thread.id, { assistant_id: process.env.ASSISTANT_ID });
    let runStatus;
    do {
      runStatus = await client.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (true);
    
    // THIS IS THE CORRECTED LINE:
    const messages = await client.beta.threads.messages.list(thread.id);
    
    const assistantReply = messages.data.find(m => m.role === 'assistant').content[0].text.value;

    if (assistantReply.toLowerCase().includes("our sourcing agent will connect")) {
      await sendToGoogleSheet(thread.id);
    }
    
    const userFacingReply = assistantReply.split('###JSON_DATA###')[0].trim();
    res.json({ reply: userFacingReply, threadId: thread.id });

  } catch (error) {
    console.error("Error in webhook:", error);
    res.status(500).json({ reply: "Sorry, there was an error processing your request." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));