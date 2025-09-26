import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import OpenAI from "openai";
// The Zoho SDK is now imported as a single object
import ZCRMRMSDK from "@zohocrm/nodejs-sdk-2.0";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// --- Zoho CRM SDK Initialization ---
async function initializeZohoSDK() {
  if (!process.env.ZOHO_CLIENT_ID || !process.env.LEAD_NOTIFICATION_EMAIL) {
    console.log("Zoho credentials not fully configured. SDK not initialized.");
    return;
  }
  // All Zoho classes are now accessed through the main ZCRMRMSDK object
  const user = new ZCRMRMSDK.UserSignature(process.env.LEAD_NOTIFICATION_EMAIL);
  const environment = ZCRMRMSDK.USDataCenter.PRODUCTION();
  const token = new ZCRMRMSDK.OAuthToken({
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  });
  const sdkConfig = new ZCRMRMSDK.SDKConfig({});

  await new ZCRMRMSDK.SDKInitializer(user, environment, token, sdkConfig, null);
  console.log("Zoho SDK Initialized Successfully.");
}
initializeZohoSDK();
// --- End Zoho Initialization ---


app.get("/", (req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Function to send the conversation to Zoho CRM
async function sendToZohoCRM(threadId) {
  if (!process.env.ZOHO_CLIENT_ID) {
    console.log("Zoho credentials not configured. Skipping CRM integration.");
    return;
  }
  try {
    const messagesList = await client.beta.threads.messages.list(threadId);
    let transcript = "";
    for (const message of messagesList.data.reverse()) {
      const role = message.role === "user" ? "User" : "Assistant";
      const content = message.content[0].text.value;
      transcript += `${role}: ${content}\n\n`;
    }
    
    const emailMatch = transcript.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
    const userEmail = emailMatch ? emailMatch[0] : null;

    if (!userEmail) {
      console.log("No email found in transcript. Cannot create CRM contact.");
      return;
    }
    
    const recordOperations = new ZCRMRMSDK.Record.RecordOperations();
    const requestBody = new ZCRMRMSDK.Record.BodyWrapper();
    const records = [];

    const contactRecord = new ZCRMRMSDK.Record.Record();
    contactRecord.addFieldValue(ZCRMRMSDK.Record.Field.Contacts.EMAIL, userEmail);
    contactRecord.addFieldValue(ZCRMRMSDK.Record.Field.Contacts.LAST_NAME, userEmail.split('@')[0]);
    contactRecord.addFieldValue(ZCRMRMSDK.Record.Field.Contacts.LEAD_SOURCE, "Chatbot");
    records.push(contactRecord);
    requestBody.setData(records);

    const contactResponse = await recordOperations.createRecords("Contacts", requestBody);
    const actionResponse = contactResponse.body.data[0].details;
    const contactId = actionResponse.id;
    console.log(`Created new contact in Zoho with ID: ${contactId}`);

    const notesRequestBody = new ZCRMRMSDK.Record.BodyWrapper();
    const notesRecords = [];
    const noteRecord = new ZCRMRMSDK.Record.Record();
    noteRecord.addFieldValue(ZCRMRMSDK.Record.Field.Notes.NOTE_TITLE, `Chatbot Transcript - ${new Date().toLocaleDateString()}`);
    noteRecord.addFieldValue(ZCRMRMSDK.Record.Field.Notes.NOTE_CONTENT, transcript);
    const parentRecord = new ZCRMRMSDK.Record.Record();
    parentRecord.setId(contactId);
    noteRecord.addFieldValue(ZCRMRMSDK.Record.Field.Notes.PARENT_ID, parentRecord);
    notesRecords.push(noteRecord);
    notesRequestBody.setData(notesRecords);

    await recordOperations.createRecords("Notes", notesRequestBody);
    console.log(`Added transcript as a note for contact ${contactId}`);

  } catch (error) {
    console.error("Error sending data to Zoho CRM:", error);
  }
}

// Endpoint to start a new conversation
app.post("/start", async (req, res) => {
  try {
    const thread = await client.beta.threads.create();
    res.json({ threadId: thread.id });
  } catch (error) {
    console.error("Error creating thread:", error);
    res.status(500).json({ error: "Could not start conversation." });
  }
});

// Webhook to handle chatbot messages
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
    
    const messages = await client.beta.threads.messages.list(thread.id);
    const assistantReply = messages.data.find(m => m.role === 'assistant').content[0].text.value;

    if (assistantReply.toLowerCase().includes("our sourcing agent will connect")) {
      await sendToZohoCRM(thread.id);
    }

    res.json({ reply: assistantReply, threadId: thread.id });
  } catch (error) {
    console.error("Error in webhook:", error);
    res.status(500).json({ reply: "Sorry, there was an error processing your request." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));