import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static files from 'public' folder
app.use(express.static("public"));

// Serve index.html at root
app.get("/", (req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

// Initialize OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Endpoint to start a new conversation and get a greeting
app.post("/start", async (req, res) => {
  try {
    console.log("Starting a new conversation.");
    const thread = await client.beta.threads.create();

    // Run the assistant on the empty thread to get the initial greeting
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // Wait for the run to complete
    let runStatus;
    do {
      runStatus = await client.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (true);

    // Get the assistant's greeting message
    const messages = await client.beta.threads.messages.list(thread.id);
    const greeting = messages.data.find(m => m.role === 'assistant').content[0].text.value;

    // Send back the new threadId and the greeting
    res.json({ threadId: thread.id, greeting: greeting });

  } catch (error) {
    console.error("Error starting conversation:", error);
    res.status(500).json({ error: "Could not start conversation." });
  }
});

// Webhook to handle chatbot messages
app.post("/webhook", async (req, res) => {
  try {
    const { message: userMessage, threadId: existingThreadId } = req.body;
    let thread;

    if (existingThreadId) {
      // If a threadId was passed from the front-end, use it
      console.log(`Continuing with existing thread: ${existingThreadId}`);
      thread = { id: existingThreadId };
    } else {
      // If no threadId, create a new one (fallback, should be created by /start)
      console.log("Creating a new thread from webhook.");
      thread = await client.beta.threads.create();
    }

    // Add user's message to the thread
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userMessage,
    });

    // Run the assistant
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // Wait until run completes
    let runStatus;
    do {
      runStatus = await client.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (true);

    // Get the latest assistant reply
    const messages = await client.beta.threads.messages.list(thread.id);
    const assistantReply = messages.data.find(m => m.role === 'assistant').content[0].text.value;

    // Respond with the reply AND the threadId
    res.json({ reply: assistantReply, threadId: thread.id });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ reply: "Sorry, there was an error processing your request." });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));