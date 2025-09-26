import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import OpenAI from "openai";

// Corrected Zoho SDK imports using the default export for CJS compatibility
import UserSignature_1 from "@zohocrm/nodejs-sdk-2.0/routes/user_signature.js";
const UserSignature = UserSignature_1.UserSignature;
import Initializer from "@zohocrm/nodejs-sdk-2.0/routes/initializer.js";
const { SDKInitializer } = Initializer;
import USDataCenter_1 from "@zohocrm/nodejs-sdk-2.0/routes/dc/us_data_center.js";
const USDataCenter = USDataCenter_1.USDataCenter;
import OAuthToken_1 from "@zohocrm/nodejs-sdk-2.0/models/authenticator/oauth_token.js";
const OAuthToken = OAuthToken_1.OAuthToken;
import SDKConfig_1 from "@zohocrm/nodejs-sdk-2.0/routes/sdk_config.js";
const SDKConfig = SDKConfig_1.SDKConfig;
import RecordOperations_1 from "@zohocrm/nodejs-sdk-2.0/core/com/zoho/crm/api/record/record_operations.js";
const RecordOperations = RecordOperations_1.RecordOperations;
import BodyWrapper_1 from "@zohocrm/nodejs-sdk-2.0/core/com/zoho/crm/api/record/body_wrapper.js";
const BodyWrapper = BodyWrapper_1.BodyWrapper;
import Record_1 from "@zohocrm/nodejs-sdk-2.0/core/com/zoho/crm/api/record/record.js";
const Record = Record_1.Record;
import Field_1 from "@zohocrm/nodejs-sdk-2.0/core/com/zoho/crm/api/record/field.js";
const Field = Field_1.Field;


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
  const user = new UserSignature(process.env.LEAD_NOTIFICATION_EMAIL);
  const environment = USDataCenter.PRODUCTION();
  const token = new OAuthToken({
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  });
  const sdkConfig = new SDKConfig({});
  await SDKInitializer.initialize(user, environment, token, sdkConfig, null);
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
    
    const recordOperations = new RecordOperations();
    const requestBody = new BodyWrapper();
    const records = [];
    const contactRecord = new Record();
    contactRecord.addFieldValue(Field.Contacts.EMAIL, userEmail);
    contactRecord.addFieldValue(Field.Contacts.LAST_NAME, userEmail.split('@')[0]);
    contactRecord.addFieldValue(Field.Contacts.LEAD_SOURCE, "Chatbot");
    records.push(contactRecord);
    requestBody.setData(records);

    const contactResponse = await recordOperations.createRecords("Contacts", requestBody);
    const actionWrapper = contactResponse.body;
    const actionResponses = actionWrapper.getData();
    const successResponse = actionResponses[0];
    const contactId = successResponse.getDetails().id;
    console.log(`Created new contact in Zoho with ID: ${contactId}`);

    const notesRequestBody = new BodyWrapper();
    const notesRecords = [];
    const noteRecord = new Record();
    noteRecord.addFieldValue(Field.Notes.NOTE_TITLE, `Chatbot Transcript - ${new Date().toLocaleDateString()}`);
    noteRecord.addFieldValue(Field.Notes.NOTE_CONTENT, transcript);
    const parentRecord = new Record();
    parentRecord.setId(contactId);
    noteRecord.addFieldValue(Field.Notes.PARENT_ID, parentRecord);
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
app.listen(PORT, ()